// SPDX-License-Identifier: GPL-3.0-only
// Node checks of the editor's song export (no browser, no hardware). Run from the repo root:
//   node web/test_song.mjs [OUT_DIR]
// The SONG section of editor.html (between SONG-BEGIN/END) on a made-up song: note timing as
// seq.c seq_step plays it (DIV incl. the slow rates, LEN, GATE, swing, ties, slides, accents, lane hits,
// chance, polymeter), then the .mid and .it it writes, read back by the small readers below, and
// readSong against the mock device. With OUT_DIR the files are kept there (for a player check,
// e.g. ffmpeg -i song.it, which decodes .it with libopenmpt).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

let failed = 0;
const ok = (cond, what) => { console.log(`${what.padEnd(64)} ${cond ? "ok" : "FAIL"}`); if (!cond) failed++; };
const HERE = new URL(".", import.meta.url).pathname;
const html = readFileSync(join(HERE, "editor.html"), "utf8");
const src = html.slice(html.indexOf("/*SONG-BEGIN*/"), html.indexOf("/*SONG-END*/"));
const S = vm.runInNewContext(src + ";({ SONG, songEvents, songToMidi, songToIT, songStepTicks })", {});

const N = (notes, o = {}) => ({ n: notes.length, notes: [...notes, 0, 0, 0, 0].slice(0, 4), time: 0, flags: o.f || 0, vel: o.v || 0,
  hit: o.hit || 0, acc: o.acc || 0, chance: o.c ?? 100 });
const H = (hit, acc = 0, o = {}) => N([], { ...o, hit, acc });
const TIE = { n: 0, notes: [0, 0, 0, 0], time: 1, flags: 0, vel: 0, hit: 0, acc: 0, chance: 100 };
const REST = { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0, chance: 100 };
const pad = (a, n = 64) => [...a, ...Array(n - a.length).fill(REST)];
const K = 1, SN = 2, HC = 8, HO = 16;            /* lane bits: KICK 36, SNARE 38, HAT CL 42, HAT OP 46 */
const song = {
  bpm: 120, swing: 0, name: "test song",
  tracks: [
    { name: "1 bass", engineName: "ANALOG", drum: false, level: 104, pan: -20, mute: false, len: 16, div: 2, swing: 0, gate: 64,
      steps: pad([N([36], { v: 100 }), TIE, TIE, REST, N([38], { f: 2 }), N([41]), REST, REST,
        N([36, 43], { f: 1 }), REST, N([40], { c: 0 }), N([45], { c: 50 }), REST, REST, REST, REST]) },
    { name: "2 lead", engineName: "VOICE", drum: false, level: 90, pan: 30, mute: false, len: 12, div: 5, swing: 80, gate: 100,
      steps: pad([N([60]), N([64]), N([67]), REST, REST, REST, N([72], { v: 80 }), REST, REST, REST, REST, REST]) },
    { name: "3 pad", engineName: "FM6", drum: false, level: 100, pan: 0, mute: false, len: 1, div: 7, swing: 0, gate: 120,
      steps: pad([N([48, 55, 60])]) },
    { name: "4 DRUM", engineName: "DRUM", drum: true, level: 110, pan: 0, mute: true, len: 16, div: 2, swing: 0, gate: 64,
      steps: pad([H(K | HC), REST, H(HC), REST, H(SN | HC, SN), REST, H(HC), REST, H(K | HC), REST, H(HC), REST, H(SN | HC), REST, H(HO), REST]) },
  ],
};

/* ---------------------------------------------------------------- timing --- */
const ev = S.songEvents(song);
ok(ev.ppq === 96, "96 ticks per beat");
ok(S.songStepTicks(2) === 24 && S.songStepTicks(5) === 16 && S.songStepTicks(6) === 192 && S.songStepTicks(7) === 384 && S.songStepTicks(9) === 1536,
  "DIV ticks: 1/16 24, 16T 16, 1/2 192, 1/1 384, 4BAR 1536");
// bass 16 x 24 = 384; lead 12 x 16 = 192; pad 1 x 384; drums 384 -> lcm 384
ok(ev.total === 384, `loop = lcm of the track loops (384, got ${ev.total})`);
const [bass, lead, padE, drums] = ev.tracks.map((t) => t.events);
// NOTE + 2 TIE: the last TIE (at 48) ends at gate 12 + half a step 12 = 72, never past the next step (72)
ok(bass[0].t === 0 && bass[0].dur === 72, `NOTE + 2 TIE ends at the TIE's gate + half a step (72, got ${bass[0].dur})`);
ok(bass[0].vel === 100, "step velocity kept");
ok(bass[1].note === 38 && bass[1].t === 96 && bass[1].dur === 24, "SLIDE step held to the next step");
ok(bass[2].note === 41 && bass[2].slide === true, "the note after a slide glides in");
ok(bass[1].vel === 96, "velocity 0 plays as 96");
const chord = bass.filter((e) => e.t === 192);
ok(chord.length === 2 && chord.every((e) => e.vel === 127) && chord[1].slot === 1, "accent chord: 2 notes, 127, slots 0 and 1");
ok(!bass.some((e) => e.note === 40), "a step at chance 0 never plays: left out");
ok(bass.some((e) => e.note === 45 && e.chance === 50), "a step at chance 50 is kept (marked 50)");
ok(lead.length === 8, `the 12-step lead loops twice in 384 ticks (got ${lead.length} notes)`);
const sw = Math.round(80 * 16 / 250);
ok(lead[1].t === 16 + sw && lead[0].t === 0, `swing 80: odd steps start ${sw} ticks late`);
ok(S.songEvents({ ...song, swing: 60 }).tracks[1].events[1].t === 16 + Math.round(100 * 16 / 250), "track + global swing capped at 100");
ok(lead[0].dur === Math.round(16 * 100 / 128), "gate 100/128 of a 16T step");
ok(padE.length === 3 && padE.every((e) => e.t === 0 && e.dur === Math.round(384 * 120 / 128)), "1/1 DIV: one step of a bar, gate 120/128");
ok(drums.length === 12, `drum hits: one per lane bit (12, got ${drums.length})`);
ok(drums.filter((e) => e.t === 0).map((e) => e.note).join() === "36,42", "lane hits play their GM notes (KICK 36, HAT CL 42)");
ok(drums.find((e) => e.t === 96 && e.note === 38).vel === 127 && drums.find((e) => e.t === 96 && e.note === 42).vel === 96,
  "an accented lane at 127, the others at the step velocity");
ok(drums[0].slot === 4 && drums[1].slot === 7, "lane hits take slots 4 + lane");
ok(S.songEvents({ ...song, tracks: [{ ...song.tracks[0], steps: pad([]) }] }).total === 0, "nothing to export -> total 0");
ok(S.songEvents(song, { loops: 3 }).total === 384 * 3, "loops: the longest loop x 3");

/* ------------------------------------------------------------------ MIDI --- */
function readMidi(b) {
  const u32 = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  const id = (o) => String.fromCharCode(...b.slice(o, o + 4));
  if (id(0) !== "MThd" || u32(4) !== 6) throw new Error("MThd");
  const fmt = b[8] << 8 | b[9], ntr = b[10] << 8 | b[11], div = b[12] << 8 | b[13];
  const tracks = [];
  let o = 14;
  for (let t = 0; t < ntr; t++) {
    if (id(o) !== "MTrk") throw new Error("MTrk " + t);
    const end = o + 8 + u32(o + 4);
    let p = o + 8, now = 0, run = 0;
    const evs = [];
    const vlq = () => { let v = 0, c; do { c = b[p++]; v = v << 7 | (c & 0x7F); } while (c & 0x80); return v; };
    while (p < end) {
      now += vlq();
      let st = b[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xFF) { const ty = b[p++], n = vlq(); evs.push({ t: now, meta: ty, data: b.slice(p, p + n) }); p += n; continue; }
      run = st;
      const hi = st & 0xF0, nd = hi === 0xC0 || hi === 0xD0 ? 1 : 2;
      evs.push({ t: now, st, d: b.slice(p, p + nd) });
      p += nd;
    }
    tracks.push(evs);
    o = end;
  }
  return { fmt, div, tracks };
}
const mid = S.songToMidi(song);
const M = readMidi(mid);
ok(M.fmt === 1 && M.div === 96, "SMF type 1, 96 ticks per quarter");
ok(M.tracks.length === 1 + 4, "tempo track + 4 tracks with notes");
const tempo = M.tracks[0].find((e) => e.meta === 0x51);
ok(tempo && ((tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2]) === 500000, "tempo 120 BPM = 500000 us/beat");
const ons = (tr, ch) => tr.filter((e) => e.st === (0x90 | ch) && e.d[1] > 0);
const offs = (tr, ch) => tr.filter((e) => e.st === (0x80 | ch));
ok(ons(M.tracks[1], 0).length === bass.length && offs(M.tracks[1], 0).length === bass.length, "track 1 on channel 1: every note on and off");
ok(ons(M.tracks[2], 1).length === 8 && ons(M.tracks[3], 2).length === 3, "tracks 2 and 3 on channels 2 and 3");
ok(ons(M.tracks[4], 9).length === 12, "the DRUM track on channel 10 (GM)");
const slideOff = offs(M.tracks[1], 0).find((e) => e.d[0] === 38);
ok(slideOff && slideOff.t === 121, "slide overlaps the next note by one tick (legato)");
ok(M.tracks[4].some((e) => e.meta === 0x03 && String.fromCharCode(...e.data).includes("(muted)")), "a muted track is named so");
ok(M.tracks[1].some((e) => e.st === 0xB0 && e.d[0] === 10 && e.d[1] === 44), "pan -20 -> CC10 44");

/* -------------------------------------------------------------------- IT --- */
function readIT(b) {
  const u16 = (o) => b[o] | b[o + 1] << 8, u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  if (String.fromCharCode(...b.slice(0, 4)) !== "IMPM") throw new Error("IMPM");
  const ordn = u16(0x20), insn = u16(0x22), smpn = u16(0x24), patn = u16(0x26);
  const o = { speed: b[0x32], tempo: b[0x33], flags: u16(0x2C), pan: [...b.slice(0x40, 0x80)], vol: [...b.slice(0x80, 0xC0)],
    orders: [...b.slice(0xC0, 0xC0 + ordn)], insn, samples: [], patterns: [] };
  let q = 0xC0 + ordn + insn * 4;
  for (let i = 0; i < smpn; i++) {
    const h = u32(q + i * 4);
    if (String.fromCharCode(...b.slice(h, h + 4)) !== "IMPS") throw new Error("IMPS " + i);
    o.samples.push({ flags: b[h + 0x12], len: u32(h + 0x30), c5: u32(h + 0x3C), ptr: u32(h + 0x48),
      name: String.fromCharCode(...b.slice(h + 0x14, h + 0x2E)).replace(/\0.*$/, "") });
  }
  q += smpn * 4;
  for (let i = 0; i < patn; i++) {
    const at = u32(q + i * 4), len = u16(at), rows = u16(at + 2), cells = [];
    let p = at + 8, row = 0;
    const lastMask = [];
    while (row < rows && p < at + 8 + len) {
      const cv = b[p++];
      if (!cv) { row++; continue; }
      const ch = (cv - 1) & 63;
      const mask = cv & 0x80 ? b[p++] : lastMask[ch];
      lastMask[ch] = mask;
      const c = { row, ch };
      if (mask & 1) c.note = b[p++];
      if (mask & 2) c.ins = b[p++];
      if (mask & 4) c.vol = b[p++];
      if (mask & 8) { c.cmd = b[p++]; c.param = b[p++]; }
      cells.push(c);
    }
    o.patterns.push({ rows, cells, end: p === at + 8 + len });
  }
  return o;
}
const it = S.songToIT(song);
const I = readIT(it);
ok(I.insn === 0 && (I.flags & 4) === 0, "sample mode (no instruments)");
// rows per beat: lcm(4, 4 for 1/16, 6 for 16T, 1 for 1/1) = 12 -> speed 2, tempo stays 120
ok(I.speed === 2 && I.tempo === 120, "rows per beat 12: speed 2, tempo 120");
const all = I.patterns.flatMap((p, i) => p.cells.map((c) => ({ ...c, row: c.row + i * 192 })));
ok(I.patterns.every((p) => p.end), "every pattern decodes to its stated length");
ok(I.orders.at(-1) === 255 && I.orders.length === I.patterns.length + 1, "order list ends with 255");
ok(I.patterns.reduce((n, p) => n + p.rows, 0) === 384 / 8, "48 rows for one loop (384 ticks / 8)");
const notes = all.filter((c) => c.note != null && c.note < 120);
const nev = bass.length + lead.length + padE.length + drums.length;
ok(notes.length === nev, `every note is in a cell (${notes.length} of ${nev})`);
ok(all.some((c) => c.cmd === 7), "slide -> Gxx tone portamento");
ok(all.some((c) => c.cmd === 19 && (c.param & 0xF0) === 0xD0), "swing -> SDx note delay");
ok(all.some((c) => (c.cmd === 19 && (c.param & 0xF0) === 0xC0) || c.note === 254), "gate -> SCx / note cut");
ok(new Set(all.map((c) => c.ch)).size === 2 + 1 + 3 + 4, "one channel per used slot: 2 + 1 + 3 notes, 4 drum lanes");
const drumChans = I.pan.filter((p, c) => (p & 128) && I.vol[c] === Math.round(110 * 64 / 127)).length;
ok(drumChans === 4, "the muted DRUM track's 4 lane channels are flagged muted");
ok(I.samples.length === 3 + 4 && I.samples[0].flags & 0x10 && I.samples[0].c5 === 66976, "3 looped stand-ins + 4 drum hits (kick, hat cl, snare, hat op)");
ok(I.samples.slice(3).map((s) => s.name).join() === "KICK,HAT CL,SNARE,HAT OP", "drum samples named after their lanes");
ok(I.samples.every((s) => s.ptr + s.len * 2 <= it.length && s.flags & 2), "16-bit sample data inside the file");

/* ------------------------------------------------- read from the mock device --- */
{
  const proto = html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/"));
  const E = vm.runInNewContext(proto + src + ";({ parse, req, CMD, Link, makeMockDevice, readSong, songEvents, songToMidi, songToIT })",
    { setTimeout, clearTimeout, setInterval, clearInterval, console });
  const m = E.makeMockDevice();
  const inp = [...m.access.inputs.values()][0], out = [...m.access.outputs.values()][0];
  const link = new E.Link((d) => out.send(d), { timeout: 300 });
  inp.onmidimessage = (e) => link.receive(e.data);
  const rq = async (r, o) => link.request(r, o);
  const info = E.parse[E.CMD.INFO](await rq(E.req.info()));
  const pdesc = [], gdesc = [];
  for (let i = 0; i < info.pcount; i++) pdesc.push(E.parse[E.CMD.DESC](await rq(E.req.desc(0, i))));
  for (let i = 0; i < info.gcount; i++) gdesc.push(E.parse[E.CMD.DESC](await rq(E.req.desc(1, i))));
  const lab = (d, l) => d.findIndex((x) => x && x.label === l);
  const len = pdesc.findIndex((d) => d && d.label === "LEN");
  const ids = { len, div: len + 1, swing: len + 2, gate: len + 3, pan: lab(pdesc, "PAN"), gbpm: lab(gdesc, "BPM"), gswing: lab(gdesc, "BPM") + 1 };
  ok(pdesc[ids.div].label === "DIV" && pdesc[ids.swing].label === "SWG" && pdesc[ids.gate].label === "GATE" && gdesc[ids.gswing].label === "SWG",
    "mock: LEN, DIV, SWG, GATE are adjacent; BPM then SWG in globals");
  ok(info.ntrk === 4, "mock: four tracks (every track a part)");
  for (let k = 0; k < info.nstep; k++) await rq(E.req.trackStep(1, k, { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0, chance: 100 }));
  await rq(E.req.trackStep(1, 0, { n: 2, notes: [60, 64, 0, 0], time: 0, flags: 1, vel: 0, hit: 1 | 8, acc: 1, chance: 100 }));
  await rq(E.req.trackStep(1, 1, { n: 0, notes: [0, 0, 0, 0], time: 1, flags: 0, vel: 0, hit: 0, acc: 0, chance: 100 }));
  const dump = E.parse[E.CMD.DUMP](await rq(E.req.dump()), info);
  let calls = 0;
  const sg = await E.readSong(rq, info, [], dump.g, ids, () => calls++);
  ok(sg.tracks.length === 4 && calls === 4 * info.nstep, "mock: readSong reads 4 tracks x every step");
  const t1 = sg.tracks[1];
  ok(t1.steps[0].n === 2 && t1.steps[0].notes[1] === 64 && t1.steps[0].hit === 9 && t1.steps[0].acc === 1 && t1.steps[1].time === 1,
    "mock: the notes, hits and accents written are read back");
  const tr1 = E.songEvents(sg).tracks[1];
  const e1 = tr1.events.filter((e) => e.t === 0);
  ok(e1.length === 4 && e1.every((e) => e.vel === 127) && e1[0].dur > tr1.stepTicks,
    "mock: accented chord + 2 hits, tied over 2 steps");
  ok(sg.tracks.every((t) => info.engines.includes(t.engineName)), "mock: engine names from INFO");
  ok(E.songToMidi(sg).length > 40 && E.songToIT(sg).length > 0xC0, "mock: .mid and .it written");
}

if (process.argv[2]) {
  mkdirSync(process.argv[2], { recursive: true });
  writeFileSync(join(process.argv[2], "song.mid"), mid);
  writeFileSync(join(process.argv[2], "song.it"), it);
  console.log("wrote", join(process.argv[2], "song.mid"), join(process.argv[2], "song.it"));
}
console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
