function parsePace(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error('Pace must be a finite number.');
    }
    validatePaceRange(input);
    return input;
  }

  if (typeof input !== 'string') {
    throw new Error('Pace must be a string (m:ss) or number (min/km).');
  }

  const value = input.trim();
  if (!value) {
    throw new Error('Pace is required. Use format m:ss or decimal min/km.');
  }

  // Accept m:ss for common running pace input.
  if (value.includes(':')) {
    const parts = value.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid pace format. Example: 5:30');
    }

    const min = Number(parts[0]);
    const sec = Number(parts[1]);

    if (!Number.isFinite(min) || !Number.isFinite(sec) || min <= 0 || sec < 0 || sec >= 60) {
      throw new Error('Invalid pace format. Example: 5:30');
    }

    const parsed = min + sec / 60;
    validatePaceRange(parsed);
    return parsed;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid pace value. Example: 5.5');
  }

  validatePaceRange(parsed);
  return parsed;
}

function validatePaceRange(pace) {
  if (pace < 2.5 || pace > 12) {
    throw new Error('Pace out of supported range (2.5 to 12.0 min/km).');
  }
}

// Piecewise pace bands (min/km) -> cadence estimate (SPM), tuned for recreational runners.
// Example outputs:
// 4:00 -> 182 SPM, 5:00 -> 174 SPM, 6:00 -> 166 SPM, 7:00 -> 158 SPM.
const CADENCE_BANDS = [
  { maxPace: 4.25, cadenceSpm: 182 },
  { maxPace: 4.75, cadenceSpm: 178 },
  { maxPace: 5.25, cadenceSpm: 174 },
  { maxPace: 5.75, cadenceSpm: 170 },
  { maxPace: 6.25, cadenceSpm: 166 },
  { maxPace: 6.75, cadenceSpm: 162 },
  { maxPace: 7.5, cadenceSpm: 158 },
  { maxPace: Infinity, cadenceSpm: 154 }
];

function estimateCadence(pace) {
  if (!Number.isFinite(pace)) {
    throw new Error('Pace must be a finite number.');
  }

  for (const band of CADENCE_BANDS) {
    if (pace <= band.maxPace) {
      return band.cadenceSpm;
    }
  }

  return 154;
}

function targetTempo(cadence, mode = 'one_to_one') {
  if (!Number.isFinite(cadence) || cadence <= 0) {
    throw new Error('Cadence must be a positive number.');
  }

  // Default one beat per step, optional half-time feel for users.
  if (mode === 'half_time') {
    return Math.round(cadence / 2);
  }

  if (mode !== 'one_to_one') {
    throw new Error('Tempo mode must be one_to_one or half_time.');
  }

  return Math.round(cadence);
}

function tempoToleranceSteps() {
  return [5, 8, 12, 16];
}

module.exports = {
  parsePace,
  estimateCadence,
  targetTempo,
  tempoToleranceSteps
};
