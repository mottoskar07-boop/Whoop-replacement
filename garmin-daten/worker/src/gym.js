// Gym: Übungsbibliothek, Trainingspläne und nachträglich eingetragene Krafttrainings.
// Alles liegt unter einem KV-Schlüssel "gym": { exercises, plans, workouts, settings }.
// bw = Anteil des Körpergewichts, der bei der Übung bewegt wird (z. B. Klimmzug 1, Liegestütz 0,65).

export const DEFAULT_EXERCISES = [
  // Brust
  ["bench", "Bankdrücken (Langhantel)", "Brust"], ["db_bench", "Bankdrücken (Kurzhantel)", "Brust"],
  ["incline_db", "Schrägbankdrücken (Kurzhantel)", "Brust"], ["smith_incline", "Smith Machine Incline Bench Press", "Brust"],
  ["fly", "Machine Chest Fly (Butterfly)", "Brust"], ["dips", "Dips", "Brust", 1], ["pushup", "Liegestütze", "Brust", 0.65],
  // Rücken
  ["latpull", "Lat Pulldown (Latzug)", "Rücken"], ["pullup", "Klimmzüge", "Rücken", 1],
  ["machine_row", "Machine Row", "Rücken"], ["uni_close_row", "Unilateral Close Machine Row", "Rücken"],
  ["db_bench_pull", "Dumbbell Bench Pull", "Rücken"], ["cable_row", "Kabelrudern", "Rücken"],
  ["bb_row", "Rudern (Langhantel)", "Rücken"], ["db_row", "Rudern (Kurzhantel)", "Rücken"], ["deadlift", "Kreuzheben", "Rücken"],
  // Beine
  ["legext", "Leg Extension (Beinstrecker)", "Beine"], ["hor_legpress", "Horizontal Leg Press", "Beine"],
  ["legpress", "Beinpresse (45°)", "Beine"], ["lying_legcurl", "Lying Leg Curl", "Beine"], ["legcurl", "Seated Leg Curl", "Beine"],
  ["rdl", "Romanian Deadlift (RDL)", "Beine"], ["hip_adduction", "Hip Adduction", "Beine"], ["hip_abduction", "Hip Abduction", "Beine"],
  ["squat", "Kniebeuge", "Beine"], ["lunge", "Ausfallschritte", "Beine", 0.6], ["hipthrust", "Hip Thrust", "Beine"],
  ["calf_press", "Machine Calf Press", "Beine"], ["calf", "Wadenheben (stehend)", "Beine"],
  // Schultern
  ["cable_lateral", "Cable Lateral Raise", "Schultern"], ["lateral", "Seitheben (Kurzhantel)", "Schultern"],
  ["ohp", "Schulterdrücken (Langhantel)", "Schultern"], ["db_ohp", "Schulterdrücken (Kurzhantel)", "Schultern"],
  ["facepull", "Face Pulls", "Schultern"], ["revfly", "Reverse Flys", "Schultern"],
  // Arme
  ["bayesian_curl", "Bayesian Curl", "Arme"], ["hammer", "Hammer Curl", "Arme"], ["db_curl", "Bizepscurls (Kurzhantel)", "Arme"],
  ["bb_curl", "Bizepscurls (Langhantel)", "Arme"], ["tri_push", "Tricep Pushdown", "Arme"], ["skull", "French Press / SZ-Trizeps", "Arme"],
  // Core
  ["cablecrunch", "Cable Crunch", "Core"], ["legraise", "Hängendes Beinheben", "Core", 0.3],
].map(([id, name, group, bw]) => ({ id, name, group, bw: bw || 0 }));

export const DEFAULT_BODYWEIGHT = 83;

// Startpläne aus Oskars bisheriger Gym-App; werden einmalig angelegt und sind danach frei änderbar
const SEED_PLANS = [
  ["seed_pull", "Pull (Rücken & Bizeps)", ["db_bench_pull", "latpull", "uni_close_row", "bayesian_curl", "hammer"]],
  ["seed_legs", "Beine", ["legext", "hor_legpress", "lying_legcurl", "rdl", "hip_adduction", "calf_press"]],
  ["seed_upper", "Oberkörper", ["latpull", "smith_incline", "machine_row", "tri_push", "cable_lateral", "bayesian_curl", "cablecrunch"]],
  ["seed_push", "Push (Brust, Schulter, Trizeps)", ["smith_incline", "fly", "cable_lateral", "tri_push", "cablecrunch"]],
].map(([id, name, ex]) => ({ id, name, items: ex.map((exId) => ({ exId, sets: 2, reps: "6–10" })) }));

export function emptyGym() {
  return { exercises: DEFAULT_EXERCISES, plans: [], workouts: {}, settings: { bodyweight: null }, seeded: false };
}

export function normalizeGym(g) {
  const base = emptyGym();
  if (!g || typeof g !== "object") g = {};
  const out = {
    // Standardübungen immer aktuell aus dem Code, gespeichert werden nur eigene (id "c_…")
    exercises: base.exercises.concat((Array.isArray(g.exercises) ? g.exercises : []).filter((e) => e && /^c_/.test(e.id))),
    plans: Array.isArray(g.plans) ? g.plans : [],
    workouts: g.workouts && typeof g.workouts === "object" ? g.workouts : {},
    settings: g.settings && typeof g.settings === "object" ? { ...g.settings } : base.settings,
    seeded: !!g.seeded,
  };
  // Einmalig: Startpläne und Körpergewicht setzen; mit dem nächsten Speichern gilt seeded = true,
  // danach gelöschte Pläne kommen nicht wieder.
  if (!out.seeded) {
    for (const p of SEED_PLANS) if (!out.plans.some((x) => x.id === p.id)) out.plans.push(p);
    if (out.settings.bodyweight == null) out.settings.bodyweight = DEFAULT_BODYWEIGHT;
    out.seeded = true;
  }
  return out;
}

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const numIn = (v, lo, hi) => { const x = Number(v); return isFinite(x) && x >= lo && x <= hi ? x : null; };

export function cleanExercises(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 300).filter((e) => e && e.id && e.name)
    .map((e) => ({ id: str(e.id, 40), name: str(e.name, 60), group: str(e.group || "Sonstige", 30), bw: numIn(e.bw, 0, 1) || 0 }));
}

export function cleanPlans(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 50).filter((p) => p && p.id && p.name).map((p) => ({
    id: str(p.id, 40), name: str(p.name, 60),
    items: (Array.isArray(p.items) ? p.items : []).slice(0, 40).filter((i) => i && i.exId)
      .map((i) => ({ exId: str(i.exId, 40), sets: numIn(i.sets, 1, 20) || 3, reps: str(i.reps || "8–12", 12) })),
  }));
}

export function cleanWorkout(w) {
  if (!w || !Array.isArray(w.entries)) return null;
  return {
    planId: w.planId ? str(w.planId, 40) : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(w.date || "") ? w.date : null,
    note: str(w.note, 500),
    entries: w.entries.slice(0, 40).filter((e) => e && e.exId).map((e) => ({
      exId: str(e.exId, 40),
      sets: (Array.isArray(e.sets) ? e.sets : []).slice(0, 20)
        .map((s) => ({ reps: numIn(s && s.reps, 0, 200), kg: numIn(s && s.kg, 0, 1000) }))
        .filter((s) => s.reps != null && s.reps > 0),
    })).filter((e) => e.sets.length),
    savedAt: new Date().toISOString(),
  };
}

// Muskel-Last aus eingetragenen Sätzen: bewegtes Gewicht (Hantel + Körpergewichtsanteil)
// × Wiederholungen, im Verhältnis zum Körpergewicht. 18 Sätze × 10 × 60 kg bei 80 kg ≈ 30.
const MUSCLE_FACTOR = 0.22;
export function muscleLoad(workout, gym) {
  if (!workout) return null;
  const bw = Number(gym.settings && gym.settings.bodyweight) || DEFAULT_BODYWEIGHT;
  const ex = Object.fromEntries((gym.exercises || []).map((e) => [e.id, e]));
  let volume = 0, sets = 0, reps = 0;
  for (const e of workout.entries || []) {
    const share = (ex[e.exId] && ex[e.exId].bw) || 0;
    for (const s of e.sets) { volume += s.reps * ((s.kg || 0) + share * bw); sets++; reps += s.reps; }
  }
  return { load: (volume / bw) * MUSCLE_FACTOR, volume, sets, reps, exercises: (workout.entries || []).length };
}
