// Erzeugt Daten im Format von /api/v1/sensing/latest, damit die Demo auch
// ohne RuView-Server läuft (index.html?mock).

const FIELD_N = 20;
const walkers = [
  { cx: -2.5, cz: -1.5, r: 1.4, speed: 0.35, phase: 0 },
  { cx: 2.5, cz: 2.0, r: 0.9, speed: 0.22, phase: 2 },
];

export function mockLatest(t) {
  const persons = walkers.map((w, i) => {
    const a = t * w.speed + w.phase;
    return {
      id: 100 + i,
      confidence: 0.9,
      position: [w.cx + Math.cos(a) * w.r, 0, w.cz + Math.sin(a * 1.3) * w.r * 0.7],
      motion_score: 10 + 6 * Math.sin(t + i),
      zone: 'tracked',
      keypoints: [],
    };
  });

  const values = new Array(FIELD_N * FIELD_N).fill(0);
  for (let iz = 0; iz < FIELD_N; iz++) {
    for (let ix = 0; ix < FIELD_N; ix++) {
      const wx = (ix - FIELD_N / 2) * 0.6;
      const wz = (iz - FIELD_N / 2) * 0.5;
      let v = 0;
      for (const p of persons) {
        const d2 = (wx - p.position[0]) ** 2 + (wz - p.position[2]) ** 2;
        v += Math.exp(-d2 / 1.2);
      }
      values[iz * FIELD_N + ix] = Math.min(1, v);
    }
  }

  const motion = 14 + 5 * Math.sin(t * 0.7);
  return {
    age_ms: 40,
    classification: { presence: true, motion_level: 'present_moving', confidence: 0.55 + 0.1 * Math.sin(t) },
    // Wie echt mit drei unkalibrierten Sensoren: springt zwischen 1 und 5.
    estimated_persons: 1 + Math.floor(Math.random() * 3) + (Math.random() < 0.3 ? 2 : 0),
    features: {
      mean_rssi: -38 + Math.sin(t * 0.3),
      motion_band_power: motion,
      breathing_band_power: 12 + 2 * Math.cos(t * 0.4),
      variance: 9 + Math.sin(t),
      dominant_freq_hz: 0.25,
    },
    // Ohne SENSING_NODE_POSITIONS meldet RuView jeden Sensor an derselben Stelle.
    nodes: [1, 2, 3].map((id) => ({ node_id: id, position: [2.0, 0.0, 1.5], rssi_dbm: -38 - id })),
    persons,
    signal_field: { grid_size: [FIELD_N, 1, FIELD_N], values },
  };
}
