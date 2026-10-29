"""معالجات أوامر البوت /agent و /agent_status (python-telegram-bot الإصدار 21).

الدمج في bot.py (ADMINS مجموعة أرقام صحيحة، والمعالجات async):

    from integrations.telegram.agent_handlers import register_agent_handlers
    register_agent_handlers(app, ADMINS, db_factory=db)

لا يصل أي مستخدم عادي للوكيل: كل معالج يتحقق من المعرّف، ويعمل في المحادثة الخاصة فقط.
"""
import asyncio

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import CallbackQueryHandler, CommandHandler, ContextTypes, filters

from integrations.telegram.agent_bridge import AgentBridge, BridgeError


def _bridge(context):
    return context.application.bot_data["agent_bridge"]


def _log_db(context, user_id, action, detail):
    """تسجيل إضافي في SQLite عبر db() الخاصة بالبوت، إن مُرِّرت."""
    factory = context.application.bot_data.get("agent_db")
    if not factory:
        return
    try:
        con = factory()
        con.execute("CREATE TABLE IF NOT EXISTS agent_log (ts TEXT DEFAULT CURRENT_TIMESTAMP, "
                    "user_id INTEGER, action TEXT, detail TEXT)")
        con.execute("INSERT INTO agent_log (user_id, action, detail) VALUES (?,?,?)",
                    (user_id, action, str(detail)[:300]))
        con.commit()
    except Exception:
        pass


async def agent_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    bridge = _bridge(context)
    if not user or not bridge.is_admin(user.id):
        return  # صمت تام مع غير المشرفين
    task = " ".join(context.args or [])
    _log_db(context, user.id, "agent", task)
    await update.message.reply_text("جارٍ التنفيذ…")
    try:
        res = await asyncio.to_thread(bridge.submit, user.id, task)
    except BridgeError as e:
        await update.message.reply_text(str(e))
        return
    await update.message.reply_text(res["reply"] or "(لا رد)")
    for tool in res["tools"]:
        token = bridge.request_approval(user.id, tool)
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("y تشغيل", callback_data=f"agent:y:{token}"),
            InlineKeyboardButton("n رفض", callback_data=f"agent:n:{token}"),
        ]])
        await update.message.reply_text(f"الأداة {tool} محفوظة ولم تُشغَّل. تشغيلها؟", reply_markup=kb)


async def agent_status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    bridge = _bridge(context)
    if not user or not bridge.is_admin(user.id):
        return
    st = bridge.status(user.id)
    last = st["last"]["status"] if st["last"] else "لا شيء"
    await update.message.reply_text(
        f"الوضع: {st['mode']}\nمشغول: {'نعم' if st['busy'] else 'لا'}\n"
        f"موافقات معلّقة: {st['pending_approvals']}\nآخر مهمة: {last}")


async def agent_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    bridge = _bridge(context)
    if not q or not bridge.is_admin(q.from_user.id):
        return
    await q.answer()
    try:
        _, choice, token = q.data.split(":", 2)
        out = await asyncio.to_thread(bridge.decide, q.from_user.id, token, choice == "y")
    except (BridgeError, ValueError) as e:
        out = str(e) if isinstance(e, BridgeError) else "طلب غير صالح."
    _log_db(context, q.from_user.id, "decision", out)
    await q.edit_message_text(out)


def register_agent_handlers(app, admins, db_factory=None, **bridge_kwargs):
    """يسجّل الأوامر. admins: مجموعة أرقام صحيحة (ADMINS في bot.py)."""
    app.bot_data["agent_bridge"] = AgentBridge(admins, **bridge_kwargs)
    app.bot_data["agent_db"] = db_factory
    private = filters.ChatType.PRIVATE
    app.add_handler(CommandHandler("agent", agent_command, filters=private))
    app.add_handler(CommandHandler("agent_status", agent_status_command, filters=private))
    app.add_handler(CallbackQueryHandler(agent_callback, pattern=r"^agent:[yn]:"))
