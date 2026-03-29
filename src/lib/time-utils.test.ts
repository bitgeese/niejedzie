import { describe, it, expect } from 'vitest';
import {
  formatTime,
  parseTimeToMinutes,
  isTimeInPast,
  isActualTimeInPast,
  isPlannedTimeInPast,
} from './time-utils';

// ── formatTime ──────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('returns null for null input', () => {
    expect(formatTime(null)).toBeNull();
  });

  it('passes through HH:MM format unchanged', () => {
    expect(formatTime('14:30')).toBe('14:30');
    expect(formatTime('09:05')).toBe('09:05');
    expect(formatTime('00:00')).toBe('00:00');
    expect(formatTime('23:59')).toBe('23:59');
  });

  it('strips seconds from HH:MM:SS format', () => {
    expect(formatTime('14:30:00')).toBe('14:30');
    expect(formatTime('09:05:45')).toBe('09:05');
  });

  it('extracts time from ISO datetime format', () => {
    expect(formatTime('2026-03-28T14:30:00')).toBe('14:30');
    expect(formatTime('2026-03-28T09:05:00')).toBe('09:05');
    expect(formatTime('2026-03-28T00:00:00')).toBe('00:00');
  });

  it('handles ISO with timezone offset', () => {
    expect(formatTime('2026-03-28T14:30:00Z')).toBe('14:30');
    expect(formatTime('2026-03-28T14:30:00+02:00')).toBe('14:30');
  });
});

// ── parseTimeToMinutes ──────────────────────────────────────────────────

describe('parseTimeToMinutes', () => {
  it('parses valid HH:MM to total minutes', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('01:00')).toBe(60);
    expect(parseTimeToMinutes('14:30')).toBe(870);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('returns null for invalid strings', () => {
    expect(parseTimeToMinutes('invalid')).toBeNull();
    expect(parseTimeToMinutes('25:00')).toBeNull();
    expect(parseTimeToMinutes('12:60')).toBeNull();
    expect(parseTimeToMinutes('-1:00')).toBeNull();
  });

  it('returns null for ISO-format strings (not normalized)', () => {
    // This is the bug scenario — if someone passes ISO without normalizing first
    expect(parseTimeToMinutes('2026-03-28T14')).toBeNull();
  });
});

// ── isTimeInPast ────────────────────────────────────────────────────────

describe('isTimeInPast', () => {
  // Fix "now" to 2026-03-28 14:30 Poland time for deterministic tests
  const fakeNow = new Date('2026-03-28T12:30:00Z'); // UTC 12:30 = Poland CEST 14:30

  it('returns false for null input', () => {
    expect(isTimeInPast(null, '2026-03-28', fakeNow)).toBe(false);
  });

  // fakeNow = UTC 12:30 = Poland CET 13:30 (DST starts March 29 in 2026)

  it('returns true for past HH:MM time on same day', () => {
    expect(isTimeInPast('09:00', '2026-03-28', fakeNow)).toBe(true);
    expect(isTimeInPast('13:00', '2026-03-28', fakeNow)).toBe(true);
  });

  it('returns false for future HH:MM time on same day', () => {
    expect(isTimeInPast('14:00', '2026-03-28', fakeNow)).toBe(false);
    expect(isTimeInPast('23:59', '2026-03-28', fakeNow)).toBe(false);
  });

  it('returns true for past ISO datetime on same day', () => {
    expect(isTimeInPast('2026-03-28T09:00:00', '2026-03-28', fakeNow)).toBe(true);
    expect(isTimeInPast('2026-03-28T13:00:00', '2026-03-28', fakeNow)).toBe(true);
  });

  it('returns false for future ISO datetime on same day', () => {
    expect(isTimeInPast('2026-03-28T14:00:00', '2026-03-28', fakeNow)).toBe(false);
    expect(isTimeInPast('2026-03-28T23:59:00', '2026-03-28', fakeNow)).toBe(false);
  });

  it('returns true for HH:MM:SS format in the past', () => {
    expect(isTimeInPast('09:00:00', '2026-03-28', fakeNow)).toBe(true);
  });

  it('returns true for past operating date (yesterday)', () => {
    expect(isTimeInPast('23:59', '2026-03-27', fakeNow)).toBe(true);
  });

  it('returns false for future operating date (tomorrow)', () => {
    expect(isTimeInPast('00:01', '2026-03-29', fakeNow)).toBe(false);
  });

  it('returns false for malformed time strings', () => {
    expect(isTimeInPast('not-a-time', '2026-03-28', fakeNow)).toBe(false);
    expect(isTimeInPast('', '2026-03-28', fakeNow)).toBe(false);
  });
});

// ── isActualTimeInPast ──────────────────────────────────────────────────

describe('isActualTimeInPast', () => {
  const fakeNow = new Date('2026-03-28T12:30:00Z');

  it('prefers departure over arrival', () => {
    // Departure is in the past, arrival would be future — should use departure
    expect(isActualTimeInPast('15:00', '13:00', '2026-03-28', fakeNow)).toBe(true);
  });

  it('falls back to arrival when departure is null', () => {
    expect(isActualTimeInPast('09:00', null, '2026-03-28', fakeNow)).toBe(true);
  });

  it('returns false when both are null', () => {
    expect(isActualTimeInPast(null, null, '2026-03-28', fakeNow)).toBe(false);
  });

  it('handles ISO format from database (THE critical bug scenario)', () => {
    // This is exactly the data format that caused the bug:
    // Scraper now stores HH:MM directly, but old data may still be ISO
    expect(isActualTimeInPast(
      '2026-03-28T09:00:00',  // arrival
      '2026-03-28T09:05:00',  // departure
      '2026-03-28',
      fakeNow,
    )).toBe(true);
  });
});

// ── isPlannedTimeInPast ─────────────────────────────────────────────────

describe('isPlannedTimeInPast', () => {
  const fakeNow = new Date('2026-03-28T12:30:00Z');

  it('returns true for planned departure in the past', () => {
    expect(isPlannedTimeInPast('09:00', null, '2026-03-28', fakeNow)).toBe(true);
  });

  it('returns false for planned departure in the future', () => {
    expect(isPlannedTimeInPast('16:00', null, '2026-03-28', fakeNow)).toBe(false);
  });

  it('falls back to arrival when departure is null', () => {
    expect(isPlannedTimeInPast(null, '09:00', '2026-03-28', fakeNow)).toBe(true);
  });

  it('handles ISO format', () => {
    expect(isPlannedTimeInPast(
      '2026-03-28T09:00:00',
      null,
      '2026-03-28',
      fakeNow,
    )).toBe(true);
  });
});

// ── Integration scenario ────────────────────────────────────────────────

describe('train 1812 scenario (the original bug)', () => {
  // Train IC 1812: Suwałki 05:27 → Świnoujście 16:17
  // Current time: ~14:30 Poland time
  const fakeNow = new Date('2026-03-28T12:30:00Z');
  const operatingDate = '2026-03-28';

  const stations = [
    { name: 'Suwałki', dep: '2026-03-28T05:27:00' },
    { name: 'Białystok', arr: '2026-03-28T07:08:00' },
    { name: 'Warszawa Centralna', arr: '2026-03-28T09:03:00' },
    { name: 'Poznań Główny', arr: '2026-03-28T12:14:00' },
    { name: 'Szczecin Główny', arr: '2026-03-28T14:33:00' },
    { name: 'Świnoujście', arr: '2026-03-28T16:17:00' },
  ];

  it('marks past stations as passed via actual times', () => {
    for (const s of stations) {
      const arr = s.arr ?? null;
      const dep = s.dep ?? null;
      const result = isActualTimeInPast(arr, dep, operatingDate, fakeNow);

      if (s.name === 'Suwałki' || s.name === 'Białystok' || s.name === 'Warszawa Centralna' || s.name === 'Poznań Główny') {
        expect(result, `${s.name} should be passed`).toBe(true);
      }
      if (s.name === 'Szczecin Główny' || s.name === 'Świnoujście') {
        expect(result, `${s.name} should NOT be passed`).toBe(false);
      }
    }
  });

  it('marks past stations as passed via planned time fallback', () => {
    // Simulate no actual data — only planned times (HH:MM format)
    const plannedStations = [
      { name: 'Suwałki', dep: '05:27' },
      { name: 'Warszawa Centralna', arr: '09:03' },
      { name: 'Świnoujście', arr: '16:17' },
    ];

    for (const s of plannedStations) {
      const dep = s.dep ?? null;
      const arr = s.arr ?? null;
      const result = isPlannedTimeInPast(dep, arr, operatingDate, fakeNow);

      if (s.name === 'Suwałki' || s.name === 'Warszawa Centralna') {
        expect(result, `${s.name} should be passed`).toBe(true);
      }
      if (s.name === 'Świnoujście') {
        expect(result, `${s.name} should NOT be passed`).toBe(false);
      }
    }
  });
});
