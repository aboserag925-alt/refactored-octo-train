"use strict";
// مخزن ذاكرة أبو سراج: وحدة نقية بدون مكتبات. بحث عربي بدون نموذج ذكاء، وبدون قص صامت.
const fs = require("fs");
const path = require("path");

const MAX_TEXT = 500;
const MAX_TAG = 30;
const MAX_NOTES = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// تطبيع عربي: إزالة التشكيل والتطويل، توحيد الألف والياء والتاء المربوطة والهاء.
function normalize(input) {
  return String(input == null ? "" : input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// حذف "ال" التعريف من بداية الكلمة الطويلة ليتطابق "المشروع" مع "مشروع".
function stem(w) {
  return w.length > 4 && w.startsWith("\u0627\u0644") ? w.slice(2) : w;
}
const tokens = s => normalize(s).split(" ").filter(Boolean).map(stem);

const cleanText = t => String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
const cleanTag = t => String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, MAX_TAG);

function createMemoryStore(file) {
  if (!file) throw new Error("مسار ملف الذاكرة مطلوب.");
  const metaFile = file + ".meta";

  function atomicWrite(target, value) {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e;
    }
  }

  function load() {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!Array.isArray(data)) {
      // ملف تالف: نحفظ نسخة منه قبل البدء بقائمة فارغة، ولا نضيّع شيئًا بصمت.
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      atomicWrite(file, []);
      return [];
    }
    return data
      .filter(n => n && Number.isFinite(Number(n.id)) && typeof n.text === "string")
      .map(n => {
        const o = { id: Number(n.id), text: n.text, ts: Number(n.ts) || 0 };
        if (typeof n.tag === "string" && n.tag) o.tag = n.tag;
        return o;
      });
  }

  function readCounter() {
    try { const v = Number(JSON.parse(fs.readFileSync(metaFile, "utf8")).nextId); return Number.isFinite(v) ? v : 0; }
    catch { return 0; }
  }

  function add({ text, tag } = {}) {
    const t = cleanText(text);
    if (!t) throw new Error("نص الملاحظة فارغ.");
    const notes = load();
    const key = normalize(t);
    const dup = notes.find(n => normalize(n.text) === key);
    if (dup) return { note: dup, duplicate: true };
    if (notes.length >= MAX_NOTES) {
      throw new Error(`الذاكرة ممتلئة (${MAX_NOTES} ملاحظة). امسح ملاحظات قديمة بأداة forget ثم حاول مرة ثانية. لم يُمسح أي شيء تلقائيًا.`);
    }
    const maxId = notes.reduce((m, n) => Math.max(m, n.id), 0);
    const id = Math.max(maxId + 1, readCounter());
    const note = { id, text: t, ts: Date.now() };
    const g = cleanTag(tag);
    if (g) note.tag = g;
    atomicWrite(file, [...notes, note]);
    atomicWrite(metaFile, { nextId: id + 1 });
    return { note, duplicate: false };
  }

  function search({ query, tag, limit } = {}) {
    let n = Number(limit);
    n = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_LIMIT) : DEFAULT_LIMIT;
    let notes = load();
    const g = normalize(cleanTag(tag));
    if (g) notes = notes.filter(x => normalize(x.tag || "") === g);
    const qTokens = [...new Set(tokens(query))];
    const phrase = normalize(query);
    let rows;
    if (!qTokens.length) {
      rows = notes.map(x => ({ x, score: 0 }));
    } else {
      rows = [];
      for (const x of notes) {
        const set = new Set(tokens(x.text));
        const hits = qTokens.filter(w => set.has(w)).length;
        const phraseHit = phrase.length > 0 && normalize(x.text).includes(phrase);
        if (!hits && !phraseHit) continue;
        rows.push({ x, score: hits * 10 + (phraseHit ? 100 : 0) });
      }
    }
    rows.sort((a, b) => b.score - a.score || b.x.ts - a.x.ts || b.x.id - a.x.id);
    return rows.slice(0, n).map(({ x }) => ({ id: x.id, text: x.text, tag: x.tag || "", ts: x.ts }));
  }

  function remove(id) {
    const notes = load();
    const next = notes.filter(n => n.id !== Number(id));
    if (next.length === notes.length) return false;
    // نحفظ العدّاد قبل الحذف حتى لا يُعاد استخدام أعلى رقم في ملف قديم بلا meta.
    const maxId = notes.reduce((m, n) => Math.max(m, n.id), 0);
    atomicWrite(metaFile, { nextId: Math.max(readCounter(), maxId + 1) });
    atomicWrite(file, next);
    return true;
  }

  const count = () => load().length;
  const list = () => load();

  return { add, search, remove, count, list };
}

module.exports = { createMemoryStore, normalize, MAX_NOTES, MAX_TEXT, MAX_TAG };
