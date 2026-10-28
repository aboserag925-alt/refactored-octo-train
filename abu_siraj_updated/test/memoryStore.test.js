"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryStore, MAX_NOTES } = require("../tools/memoryStore");

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  return { dir, file: path.join(dir, "notes.json") };
}

test("إضافة ملاحظة وكشف التكرار", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  const a = m.add({ text: "  سراج يحب القهوة  ", tag: "تفضيلات" });
  assert.equal(a.duplicate, false);
  assert.equal(a.note.text, "سراج يحب القهوة");
  const b = m.add({ text: "سِراج يحب القهوة" });
  assert.equal(b.duplicate, true);
  assert.equal(b.note.id, a.note.id);
  assert.equal(m.count(), 1);
  assert.throws(() => m.add({ text: "   " }), /فارغ/);
  assert.equal(m.add({ text: "x".repeat(900) }).note.text.length, 500);
  assert.equal(m.add({ text: "ملاحظة", tag: "t".repeat(80) }).note.tag.length, 30);
});

test("بحث عربي مع اختلاف الهمزات والتشكيل والتاء المربوطة", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  m.add({ text: "أحمد يملك مزرعة دواجن" });
  m.add({ text: "اجتماع الإثنين مع المورّد" });
  m.add({ text: "شيء آخر تمامًا" });
  assert.equal(m.search({ query: "احمد" })[0].text, "أحمد يملك مزرعة دواجن");
  assert.equal(m.search({ query: "مَزرعه" }).length, 1);
  assert.equal(m.search({ query: "الاثنين المورد" })[0].text, "اجتماع الإثنين مع المورّد");
  assert.equal(m.search({ query: "غير موجود نهائيا" }).length, 0);
});

test("الترتيب: التطابق الأكثر ثم الأحدث، وبلا query يرجع الأحدث", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  m.add({ text: "سعر الدجاج اليوم" });
  m.add({ text: "سعر العلف" });
  m.add({ text: "سعر الدجاج" });
  const r = m.search({ query: "سعر الدجاج" });
  assert.equal(r.length, 3);
  assert.ok(r[0].text.includes("الدجاج"));
  const latest = m.search({});
  assert.equal(latest[0].text, "سعر الدجاج");
});

test("البحث بالوسم", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  m.add({ text: "فكرة أولى", tag: "عمل" });
  m.add({ text: "فكرة ثانية", tag: "شخصي" });
  const r = m.search({ query: "فكرة", tag: "عمل" });
  assert.equal(r.length, 1);
  assert.equal(r[0].tag, "عمل");
  assert.equal(m.search({ tag: "شخصي" }).length, 1);
});

test("الحد: الافتراضي 10 والأقصى 50", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  for (let i = 0; i < 60; i++) m.add({ text: "ملاحظة رقم " + i });
  assert.equal(m.search({}).length, 10);
  assert.equal(m.search({ limit: 3 }).length, 3);
  assert.equal(m.search({ limit: 500 }).length, 50);
});

test("رفض الامتلاء دون مسح أي شيء", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  const seed = Array.from({ length: MAX_NOTES }, (_, i) => ({ id: i + 1, text: "قديمة " + i, ts: i }));
  fs.writeFileSync(file, JSON.stringify(seed));
  assert.throws(() => m.add({ text: "جديدة تمامًا" }), /ممتلئة/);
  assert.equal(m.count(), MAX_NOTES);
  assert.equal(m.search({ query: "قديمة 0", limit: 50 }).some(n => n.id === 1), true);
  assert.equal(m.add({ text: "قديمة 3" }).duplicate, true);
  assert.equal(m.remove(1), true);
  assert.equal(m.add({ text: "جديدة تمامًا" }).duplicate, false);
});

test("عدم إعادة استخدام id بعد الحذف", () => {
  const { file } = tmp(), m = createMemoryStore(file);
  const a = m.add({ text: "أ" }).note.id, b = m.add({ text: "ب" }).note.id;
  assert.equal(m.remove(b), true);
  const c = m.add({ text: "ج" }).note.id;
  assert.ok(c > b && b > a);
  assert.equal(m.remove(9999), false);
  // حتى بعد إعادة إنشاء المخزن
  m.remove(c);
  assert.ok(createMemoryStore(file).add({ text: "د" }).note.id > c);
});

test("قراءة الصيغة القديمة (id وtext وts فقط)", () => {
  const { file } = tmp();
  fs.writeFileSync(file, JSON.stringify([{ id: 4, text: "ملاحظة قديمة", ts: 1 }, { id: 7, text: "أخرى", ts: 2 }]));
  const m = createMemoryStore(file);
  assert.equal(m.count(), 2);
  assert.equal(m.search({ query: "قديمة" })[0].id, 4);
  assert.equal(m.add({ text: "جديدة" }).note.id, 8);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(saved) && saved.length === 3);
  assert.equal(saved[0].tag, undefined);
});

test("ملف تالف: نسخة احتياطية ثم قائمة فارغة", () => {
  const { dir, file } = tmp();
  fs.writeFileSync(file, "{ هذا ليس JSON");
  const m = createMemoryStore(file);
  assert.equal(m.count(), 0);
  const copies = fs.readdirSync(dir).filter(f => f.startsWith("notes.json.corrupt-"));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), "utf8"), "{ هذا ليس JSON");
  m.add({ text: "بداية جديدة" });
  assert.equal(m.count(), 1);
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith("notes.json.corrupt-")).length, 1);
});

test("الكتابة الذرية: لا يبقى ملف مؤقت", () => {
  const { dir, file } = tmp(), m = createMemoryStore(file);
  for (let i = 0; i < 5; i++) m.add({ text: "ن" + i });
  m.remove(1);
  const left = fs.readdirSync(dir).filter(f => f.includes(".tmp-"));
  assert.deepEqual(left, []);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
});
