/**
 * AuraPet daemon - pet state math (no DOM, no storage, no Electron).
 *
 * The renderer owns animation and persistence; these are the small pure rules
 * the pet state machine is built from (affection/energy clamps, posture order,
 * idle → doze/sleep drift). UMD so the same file can be `<script>`-loaded by the
 * renderer today and `require()`d by the headless daemon once it owns the state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AuraDaemon = root.AuraDaemon || {};
    root.AuraDaemon.PetState = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_AFFECTION = 88;
  const DEFAULT_ENERGY = 95;
  const MAX_STAT = 100;
  const MIN_ENERGY = 10;
  const BASE_POSTURES = ['sit', 'doze', 'rest', 'sleep'];
  const IDLE_SLEEP_MS = 180000;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Parse a persisted stat, falling back to the default when missing/corrupt. */
  function parseStat(raw, fallback) {
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
  }

  function addAffection(current, points) {
    return Math.min(MAX_STAT, current + points);
  }

  function addEnergy(current, points) {
    return Math.min(MAX_STAT, current + points);
  }

  function spendEnergy(current, points) {
    return Math.max(MIN_ENERGY, current - points);
  }

  function normalizePosture(posture, supported = BASE_POSTURES) {
    return supported.includes(posture) ? posture : 'sit';
  }

  function isRestPose(posture) {
    return posture === 'rest' || posture === 'sleep';
  }

  function isSleepyPosture(posture) {
    return posture === 'doze' || posture === 'sleep';
  }

  function nextPosture(order, current) {
    const idx = order.indexOf(current);
    return order[(idx + 1) % order.length];
  }

  // A pat or a snack wakes a napping pet by one step, never straight to alert.
  function postureAfterPat(posture) {
    if (posture === 'doze') return 'sit';
    if (posture === 'sleep') return 'rest';
    return posture;
  }

  const postureAfterFeed = postureAfterPat;

  function postureAfterPlay() {
    return 'sit';
  }

  // Long idle drifts one step toward deeper sleep; deeper postures never wake up.
  function postureAfterIdle(posture, idleMs) {
    if (idleMs <= IDLE_SLEEP_MS) return posture;
    if (posture === 'sit') return 'doze';
    if (posture === 'rest') return 'sleep';
    return posture;
  }

  return {
    BASE_POSTURES,
    DEFAULT_AFFECTION,
    DEFAULT_ENERGY,
    IDLE_SLEEP_MS,
    MAX_STAT,
    MIN_ENERGY,
    addAffection,
    addEnergy,
    clamp,
    isRestPose,
    isSleepyPosture,
    nextPosture,
    normalizePosture,
    parseStat,
    postureAfterFeed,
    postureAfterIdle,
    postureAfterPat,
    postureAfterPlay,
    spendEnergy
  };
});
