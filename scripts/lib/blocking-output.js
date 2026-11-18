'use strict'

// Loaded into the test runner and every test file process of the complete
// suite (NODE_OPTIONS --require, scripts/compare-tests.js).
// The suite runs with --test-force-exit, because failed legacy tests leave
// timers alive. A forced exit does not wait for output: on Linux a pipe is
// written asynchronously, and whatever the reader has not taken yet beyond the
// pipe's 64 KB is dropped. A test file reports its results to the runner
// through such a pipe, and the runner writes the report through another.
// - 2026-11-18, main after #322: the third part's report had no totals twice
//   in a row and the comparison failed as "incomplete".
// - The same cut inside a test file loses results without any sign: three
//   runs of the same part reported 1312, 1303 and 1312 tests; a suite of 481
//   small tests reported 436 to 457 with exit code 0.
// With blocking pipes a write returns only once the reader has the bytes, so
// nothing is pending at the forced exit.
for (const stream of [process.stdout, process.stderr]) {
  try { stream?._handle?.setBlocking?.(true) } catch { /* Not a pipe, or closed: nothing to lose there. */ }
}
