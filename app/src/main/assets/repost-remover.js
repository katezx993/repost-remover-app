/* TikTok Repost Remover - หน้าลบรีโพสต์ (ใช้ร่วมกันทั้งแอป Android และ userscript บนคอม)
   ตรรกะสแกน/ลบ/ตรวจสอบ พอร์ตมาจาก v2.1.0 ของ yiitxyz (ปรับให้ทำงานในหน้า tiktok.com โดยตรง) */
(function () {
  'use strict';
  if (!/(^|\.)tiktok\.com$/.test(location.hostname)) return;
  if (window.__rrLoaded) return;
  window.__rrLoaded = true;

  var LOG = '[RepostRemover]', STORE = 'repost-remover-state-v3';
  var DANGER_RE = /captcha|verify|verification|too many|too frequent|rate.?limit|risk|restricted|unusual|slow down/i;
  var pageSize = 50, stopFlag = false, busy = false;
  var S = { status: 'idle', msg: 'พร้อมสแกน', items: [], cursor: '0', pages: 0, err: '', total: 0, gone: 0 };
  // total = จำนวนรีโพสต์ทั้งหมดที่สแกนเจอ, gone = จำนวนที่ลบไปแล้ว (สะสม) → คงเหลือจริง = total - gone

  // ---------- เก็บสถานะ ----------
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ items: S.items, pages: S.pages, cursor: S.cursor, total: S.total, gone: S.gone }));
    } catch (e) {}
  }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (d && Array.isArray(d.items)) {
        S.items = d.items.map(function (i) { if (i.status === 'removing') i.status = 'pending'; return i; });
        S.pages = d.pages || 0; S.cursor = d.cursor || '0';
        S.gone = d.gone || 0; S.total = d.total || (S.items.length + S.gone);
        if (S.items.length) S.msg = 'โหลดรายการที่สแกนไว้ ' + S.items.length + ' รายการ';
      }
    } catch (e) {}
  }
  function counts() {
    var c = { collected: S.items.length, selected: 0, removed: 0, failed: 0, remaining: 0 };
    S.items.forEach(function (i) {
      if (i.selected) c.selected++;
      if (i.status === 'removed') c.removed++;
      if (i.status === 'failed') c.failed++;
      if (i.selected && i.status !== 'removed') c.remaining++;
    });
    return c;
  }

  // ---------- เครือข่าย ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rnd(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
  function SafetyStop(m) { this.message = m; }
  function HttpErr(s) { this.status = s; this.message = 'TikTok request failed (' + s + ').'; }

  async function wait(ms) { // รอแบบกดหยุดได้
    var end = Date.now() + ms;
    while (!stopFlag && Date.now() < end) await sleep(Math.min(400, end - Date.now()));
    return !stopFlag;
  }
  async function req(url, opts, retries) {
    retries = retries || 0;
    var last;
    for (var a = 0; a <= retries; a++) {
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 20000);
      try {
        var o = Object.assign({}, opts || {}, { credentials: 'include', signal: ctl.signal });
        var res = await fetch(url, o);
        if (res.status === 401 || res.status === 403 || res.status === 429)
          throw new SafetyStop('TikTok ตอบกลับ ' + res.status + ' — หยุดเพื่อความปลอดภัยของบัญชี ให้ยืนยันตัวตน/รอสักพักแล้วลองใหม่');
        if (res.status >= 500) throw { retry: true, message: 'TikTok server error (' + res.status + ')' };
        if (!res.ok) throw new HttpErr(res.status);
        return await res.json();
      } catch (e) {
        last = e;
        var retryable = (e && e.retry) || (e && e.name === 'AbortError') || e instanceof TypeError;
        if (e && e.name === 'AbortError') last = { message: 'หมดเวลา 20 วินาที' };
        if (e instanceof SafetyStop || !retryable || a === retries) throw last;
        await sleep(500 * Math.pow(2, a));
      } finally { clearTimeout(t); }
    }
    throw last;
  }
  function check(json, what) {
    if (!json || json.status_code === undefined || json.status_code === 0) return;
    var m = json.status_msg || ('TikTok ทำรายการไม่ได้: ' + what + ' (' + json.status_code + ')');
    if (DANGER_RE.test(m)) throw new SafetyStop(m + ' — หยุดเพื่อความปลอดภัย');
    throw new Error(m);
  }
  function secUid() {
    try {
      var u = window.__$UNIVERSAL_DATA$__;
      var ctx = u && u.__DEFAULT_SCOPE__ && u.__DEFAULT_SCOPE__['webapp.app-context'];
      return (ctx && ctx.user && ctx.user.secUid) || null;
    } catch (e) { return null; }
  }
  function needSec() {
    var id = secUid();
    if (!id) throw new SafetyStop('ไม่พบบัญชีที่ล็อกอิน — ล็อกอิน TikTok ให้เรียบร้อย แล้วรีเฟรชหน้า แล้วลองใหม่');
    return id;
  }
  function norm(i) {
    if (!i || !i.id || !i.author || !i.author.uniqueId) return null;
    var v = i.video || {};
    return { id: String(i.id), creator: i.author.uniqueId, desc: String(i.desc || '').slice(0, 140),
      thumb: v.cover || v.originCover || '', selected: true, status: 'pending', error: '', page: 0 };
  }
  async function listPage(sec, cursor) {
    async function go(n) {
      var q = new URLSearchParams({ aid: '1988', count: String(n), coverFormat: '2', cursor: cursor,
        needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid: sec });
      return req('https://www.tiktok.com/api/repost/item_list/?' + q, undefined, 2);
    }
    var j;
    try { j = await go(pageSize); }
    catch (e) {
      if (e instanceof HttpErr && e.status === 400 && pageSize === 50) { pageSize = 30; j = await go(pageSize); }
      else throw e;
    }
    check(j, 'ดึงรายการรีโพสต์');
    var raw = j.itemList || [];
    return { items: raw.map(norm).filter(Boolean), more: !!j.hasMore,
      cursor: j.cursor == null ? cursor : String(j.cursor) };
  }

  // ---------- สแกน ----------
  async function scan() {
    var sec = needSec();
    S.items = []; S.total = 0; S.gone = 0; S.pages = 0; S.cursor = '0'; S.status = 'scanning'; S.msg = 'กำลังสแกน…'; render();
    var seen = {}, cur = '0';
    while (!stopFlag) {
      if (seen[cur]) throw new Error('TikTok ส่ง cursor ซ้ำ — เก็บผลสแกนบางส่วนไว้แล้ว');
      seen[cur] = 1;
      var p = await listPage(sec, cur);
      S.pages++;
      var known = {}; S.items.forEach(function (i) { known[i.id] = 1; });
      p.items.forEach(function (i) { if (!known[i.id]) { i.page = S.pages; S.items.push(i); } });
      S.total = S.items.length; S.cursor = p.cursor; S.msg = 'สแกนแล้ว ' + S.items.length + ' รายการ (' + S.pages + ' หน้า)';
      save(); render();
      if (!p.more) { S.status = 'scan_complete'; S.msg = 'สแกนเสร็จ: พบ ' + S.items.length + ' รายการ'; save(); render(); return true; }
      if (p.cursor === cur) throw new Error('TikTok ไม่ส่ง cursor หน้าถัดไป — เก็บผลสแกนบางส่วนไว้แล้ว');
      cur = p.cursor;
      if (!(await wait(rnd(1500, 3000)))) break;
    }
    S.status = 'scan_stopped'; S.msg = 'หยุดสแกนแล้ว เก็บรายการที่สแกนได้ไว้'; save(); render();
    return false;
  }

  // ---------- ลบ + ตรวจสอบ ----------
  async function removeOne(id) {
    var q = new URLSearchParams({ aid: '1988', item_id: id });
    var j = await req('https://www.tiktok.com/tiktok/v1/upvote/delete?' + q, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    check(j, 'ลบรีโพสต์');
  }
  async function verify(sec) {
    S.status = 'verifying';
    var limit = 1; S.items.forEach(function (i) { if (i.selected) limit = Math.max(limit, i.page || 1); });
    var present = {}, cur = '0', seen = {}, n = 0;
    while (!stopFlag) {
      if (seen[cur]) break; seen[cur] = 1;
      var p = await listPage(sec, cur); n++;
      p.items.forEach(function (i) { present[i.id] = 1; });
      S.msg = 'ตรวจสอบกับเซิร์ฟเวอร์ หน้า ' + n + '/' + limit; render();
      if (!p.more || n >= limit || p.cursor === cur) break;
      cur = p.cursor;
      if (!(await wait(rnd(1500, 3000)))) return false;
    }
    if (stopFlag) return false;
    S.items.forEach(function (i) {
      if (!i.selected) return;
      if (present[i.id]) { if (i.status !== 'failed') { i.status = 'remaining'; i.error = 'ยังอยู่หลังตรวจสอบ'; } }
      else { i.status = 'removed'; i.error = ''; }
    });
    return true;
  }
  async function deleteSelected() {
    var sec = needSec();
    S.items.forEach(function (i) { if (i.selected && i.status !== 'removed') { i.status = 'pending'; i.error = ''; } });
    if (!counts().remaining) throw new Error('ยังไม่ได้เลือกรีโพสต์ที่ต้องลบ');
    S.status = 'deleting'; save(); render();
    var streak = 0, group = rnd(50, 60);
    while (!stopFlag) {
      var it = S.items.find(function (i) { return i.selected && i.status === 'pending'; });
      if (!it) break;
      it.status = 'removing'; setRowLabel(it);
      var done = counts();
      S.msg = 'กำลังลบ ' + (done.removed + done.failed + 1) + ' / ' + (done.removed + done.failed + done.remaining);
      render();
      try { await removeOne(it.id); it.status = 'removed'; it.error = ''; hideRow(it.id); }
      catch (e) {
        if (e instanceof SafetyStop) { it.status = 'pending'; throw e; }
        it.status = 'failed'; it.error = (e && e.message) || String(e); setRowLabel(it);
      }
      save(); render();
      streak++;
      if (streak >= group) {
        if (!(await wait(rnd(2000, 3500)))) break;
        streak = 0; group = rnd(50, 60);
      } else if (!(await wait(rnd(120, 250)))) break;
    }
    if (stopFlag) {
      S.items.forEach(function (i) { if (i.status === 'removing') i.status = 'pending'; });
      S.status = 'delete_stopped'; S.msg = 'หยุดการลบแล้ว (เก็บความคืบหน้าไว้)'; save(); render(); return;
    }
    var ok = await verify(sec);
    if (!ok) { S.status = 'delete_stopped'; S.msg = 'หยุดระหว่างตรวจสอบ'; save(); render(); return; }
    var removedN = counts().removed;
    S.gone += removedN; // เก็บยอดที่ลบไปแล้วสะสมไว้ ก่อนรีเซ็ตรายการ
    S.items = S.items.filter(function (i) { return i.status !== 'removed'; }); // รีเซ็ตรายการ: เหลือเฉพาะที่ลบไม่สำเร็จ
    S.status = 'completed';
    S.msg = S.items.length === 0
      ? 'ลบเสร็จและตรวจสอบแล้ว ✅ ลบไป ' + removedN + ' รายการ · เหลือรีโพสต์ ' + Math.max(0, S.total - S.gone) + ' รายการ'
      : 'ลบแล้ว ' + removedN + ' รายการ · เหลือ ' + S.items.length + ' รายการที่ยังลบไม่สำเร็จ (กด "ลบที่เลือก" เพื่อลองใหม่)';
    save(); render();
  }

  async function run(fn) {
    if (busy) return;
    busy = true; stopFlag = false; S.err = ''; render();
    try { await fn(); }
    catch (e) {
      var m = (e && e.message) || String(e);
      console.error(LOG, m);
      S.err = m; S.status = 'interrupted'; S.msg = 'หยุดทำงาน'; save();
    } finally { busy = false; render(); }
  }

  // ---------- UI (Shadow DOM กัน CSS ชนกับ TikTok) ----------
  var host = document.createElement('div');
  host.id = 'rr-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Noto Sans Thai",sans-serif}' +
    '#fab{width:52px;height:52px;border-radius:50%;border:0;background:#fe2c55;color:#fff;font-size:26px;box-shadow:0 3px 12px #0006}' +
    '#panel{display:none;position:fixed;inset:8px;max-width:520px;margin:auto;background:#121212;color:#f1f1f1;border-radius:14px;box-shadow:0 8px 30px #000a;flex-direction:column;overflow:hidden}' +
    '#panel.open{display:flex}' +
    'header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#1c1c1c}' +
    'header b{font-size:16px}header button{background:none;border:0;color:#fff;font-size:22px}' +
    '#status{padding:10px 14px 0;font-size:14px}#err{padding:6px 14px 0;font-size:13px;color:#ff7a8e;white-space:pre-wrap}' +
    '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:10px 14px}' +
    '.stats div{background:#1e1e1e;border-radius:8px;padding:6px 2px;text-align:center}' +
    '.stats strong{display:block;font-size:17px}.stats span{font-size:10px;color:#aaa}' +
    '.row{display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 10px}' +
    '.row button{flex:1 1 40%;padding:11px 8px;border-radius:9px;border:0;background:#2d2d2d;color:#fff;font-size:14px}' +
    '.row button.danger{background:#fe2c55;font-weight:600}' +
    '.row button:disabled{opacity:.4}' +
    '#list{flex:1;overflow:auto;border-top:1px solid #2a2a2a}' +
    '.it{display:flex;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid #1f1f1f;font-size:13px}' +
    '.it img{width:42px;height:56px;object-fit:cover;border-radius:5px;background:#333}' +
    '.it .t{flex:1;min-width:0}.it .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.it .s{font-size:11px;color:#9aa}.ok{color:#4cd964!important}.bad{color:#ff7a8e!important}' +
    '.note{padding:8px 14px;font-size:11px;color:#8a8a8a}' +
    '.note.guide{white-space:pre-line;font-size:14px;line-height:1.6;color:#d0d0d0;padding:16px 18px}' +
    '</style>' +
    '<button id="fab" aria-label="Repost Remover">↻</button>' +
    '<section id="panel"><header><b>↻ ลบรีโพสต์ TikTok</b><button id="close" aria-label="ปิด">✕</button></header>' +
    '<div id="status"></div><div id="err" hidden></div>' +
    '<div class="stats">' +
    '<div><strong id="c-collected">0</strong><span>ทั้งหมด</span></div><div><strong id="c-selected">0</strong><span>เลือก</span></div>' +
    '<div><strong id="c-removed">0</strong><span>ลบแล้ว</span></div><div><strong id="c-failed">0</strong><span>ล้มเหลว</span></div>' +
    '<div><strong id="c-remaining">0</strong><span>คงเหลือ</span></div></div>' +
    '<div class="row">' +
    '<button id="b-scan">สแกนรีโพสต์</button><button id="b-del" class="danger">ลบที่เลือก</button>' +
    '<button id="b-selall">เลือกทั้งหมด</button><button id="b-selnone">ไม่เลือกเลย</button></div>' +
    '<div id="list"></div>' +
    '<div class="note">การลบย้อนกลับไม่ได้ · ใช้กับบัญชีตัวเองเท่านั้น · ใช้ endpoint ไม่เป็นทางการของ TikTok อาจถูกจำกัดบัญชีได้ แม้มีการหน่วงเวลาแล้ว · ไม่เกี่ยวข้องกับ TikTok</div></section>';
  var $ = function (id) { return root.getElementById(id); };

  var lastListKey = '';
  function render() {
    var c = counts();
    var gone = S.gone + c.removed;                 // ลบไปแล้ว (นับสดทุกครั้งที่ลบสำเร็จ)
    var left = Math.max(0, S.total - gone);        // คงเหลือจริง = ทั้งหมด - ลบแล้ว
    $('c-collected').textContent = S.total; $('c-selected').textContent = c.selected;
    $('c-removed').textContent = gone; $('c-failed').textContent = c.failed; $('c-remaining').textContent = left;
    $('status').textContent = S.msg;
    $('err').hidden = !S.err; $('err').textContent = S.err;
    $('b-scan').disabled = busy;
    $('b-selall').disabled = busy;
    $('b-selnone').disabled = busy;
    $('b-del').textContent = busy ? 'หยุด' : 'ลบที่เลือก'; // ระหว่างสแกน/ลบ ปุ่มนี้กลายเป็นปุ่มหยุด
    $('b-del').disabled = !busy && c.collected === 0;
    if (listTimer) return; // วาดรายการไม่เกิน ~2 ครั้ง/วินาที กันมือถือหน่วงระหว่างลบ
    listTimer = setTimeout(function () { listTimer = 0; drawList(); }, 250);
  }
  var listTimer = 0, rowMap = {};
  function labelOf(i) {
    var label = { pending: 'รอลบ', removing: 'กำลังลบ…', removed: 'ลบแล้ว', failed: 'ล้มเหลว: ' + i.error, remaining: i.error };
    return label[i.status] || i.status;
  }
  function statusCls(i) { return i.status === 'removed' ? ' ok' : (i.status === 'failed' || i.status === 'remaining') ? ' bad' : ''; }
  function hideRow(id) { // รายการที่ลบสำเร็จหายไปจากหน้าจอทันที
    var r = rowMap[id];
    if (r && r.row.parentNode) r.row.parentNode.removeChild(r.row);
    delete rowMap[id];
  }
  function setRowLabel(i) { // อัปเดตข้อความสถานะของแถวเดียว ไม่ต้องวาดทั้งรายการใหม่
    var r = rowMap[i.id];
    if (r) { r.s.textContent = labelOf(i); r.s.className = 's' + statusCls(i); }
  }
  function drawList() {
    // ระหว่างลบ อัปเดตทีละแถวโดยตรง (hideRow/setRowLabel) จึงไม่ต้องวาดทั้งรายการใหม่ → ลื่นและเห็นผลทันที
    var key = (busy && S.status === 'deleting') ? 'del:' + S.items.length
      : busy + ':' + S.items.length + ':' + S.items.map(function (i) { return (i.selected ? 1 : 0) + i.status[0]; }).join('');
    if (key === lastListKey) return;
    lastListKey = key;
    var list = $('list'), keepTop = list.scrollTop; list.textContent = '';
    var frag = document.createDocumentFragment();
    rowMap = {};
    var visible = S.items.filter(function (i) { return i.status !== 'removed'; });
    if (!S.items.length) {
      var none = document.createElement('div'); none.className = 'note guide';
      none.textContent = 'วิธีใช้\n1) กด "สแกนรีโพสต์"\n2) เลือกอันที่จะลบ (หรือ "เลือกทั้งหมด")\n3) กด "ลบที่เลือก" แล้วยืนยัน\n\n• ลบแล้วย้อนกลับไม่ได้\n• เปิดแอปค้างไว้ระหว่างลบ\n• กด "หยุด" ได้ทุกเมื่อ';
      frag.appendChild(none);
    } else if (!visible.length) {
      var empty = document.createElement('div'); empty.className = 'note'; empty.textContent = 'ลบครบทุกรายการแล้ว ✅';
      frag.appendChild(empty);
    }
    visible.slice(0, 400).forEach(function (i) { // แสดงสูงสุด 400 รายการเพื่อไม่ให้มือถือหน่วง
      var row = document.createElement('label'); row.className = 'it';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!i.selected;
      cb.disabled = busy || i.status === 'removed';
      cb.onchange = function () { i.selected = cb.checked; save(); render(); };
      var im = document.createElement('img'); im.loading = 'lazy'; im.referrerPolicy = 'no-referrer';
      if (i.thumb) im.src = i.thumb;
      var t = document.createElement('div'); t.className = 't';
      var a = document.createElement('div'); a.textContent = '@' + i.creator;
      var b = document.createElement('div'); b.textContent = i.desc || '(ไม่มีคำบรรยาย)';
      var s = document.createElement('div'); s.className = 's' + statusCls(i);
      s.textContent = labelOf(i);
      rowMap[i.id] = { row: row, s: s };
      t.appendChild(a); t.appendChild(b); t.appendChild(s);
      row.appendChild(cb); row.appendChild(im); row.appendChild(t); frag.appendChild(row);
    });
    if (visible.length > 400) {
      var more = document.createElement('div'); more.className = 'note';
      more.textContent = '… และอีก ' + (visible.length - 400) + ' รายการ (แสดงสูงสุด 400 รายการ แต่การลบทำครบทั้งหมดที่เลือก)';
      frag.appendChild(more);
    }
    list.appendChild(frag);
    list.scrollTop = keepTop;
  }

  function toggle() { $('panel').classList.toggle('open'); render(); }
  window.__rrToggle = toggle;
  $('fab').onclick = toggle; $('close').onclick = toggle;
  $('b-scan').onclick = function () {
    if (S.items.length && !confirm('สแกนใหม่และแทนที่รายการเดิม?')) return;
    run(scan);
  };
  $('b-del').onclick = function () {
    if (busy) { stopFlag = true; S.msg = 'กำลังหยุด…'; render(); return; }
    var n = counts().remaining;
    if (!n) { S.err = 'ยังไม่ได้เลือกรีโพสต์ที่ต้องลบ'; render(); return; }
    if (!confirm('ลบรีโพสต์ที่เลือก ' + n + ' รายการ?\nการลบย้อนกลับไม่ได้')) return;
    run(deleteSelected);
