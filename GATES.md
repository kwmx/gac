# Gates: Ctrl+C Terminal Exit Sweep

OWNS: src/**, test/**, scripts/**, GATES.md

Scope: every interactive terminal prompt or menu in GAC responds to Ctrl+C as an immediate process cancel/exit without falling through to the next command stage.

- [x] G1: terminal-kit prompt and menu call sites are covered by explicit Ctrl+C cancellation policy
  CHECK: node scripts/check-ctrl-c-coverage.mjs
  EXPECT: ctrl-c coverage verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Volumes/NVMEA/projects/gac; path=6609cc538786/27 entries; EXPECT=matched; output-sha256=c81719ca4f36c2d5578b57ff078fdc12d20c6bfa07b26bbd723e46c133b155da; output-bytes=36

- [x] G2: focused regression tests cover the shared cancel helpers and telemetry cancellation semantics
  CHECK: node scripts/check-focused-ctrl-c-tests.mjs
  EXPECT: focused ctrl-c regression tests passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Volumes/NVMEA/projects/gac; path=6609cc538786/27 entries; EXPECT=matched; output-sha256=0cf528ede4c291b1bfa9c855bd9669a966e11a23964891f7c51699120cdd5c7b; output-bytes=4369

- [x] G3: a real PTY Ctrl+C at the first-run telemetry prompt exits with status 130 before commit continues
  CHECK: python3 scripts/smoke-ctrl-c-telemetry-prompt.py
  EXPECT: ctrl-c telemetry prompt smoke passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Volumes/NVMEA/projects/gac; path=6609cc538786/27 entries; EXPECT=matched; output-sha256=d986e82ca462db451820c08acf9d2fb5841dcc2d65d4bdd532894441b7201ac5; output-bytes=37

- [x] G4: full Node test suite passes after the terminal cancellation changes
  CHECK: node scripts/check-full-test-suite.mjs
  EXPECT: full test suite passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Volumes/NVMEA/projects/gac; path=6609cc538786/27 entries; EXPECT=matched; output-sha256=a950937997f3fff94ba40a9b34f971b5e40ea655ca356c263d7af92d0af9eaa8; output-bytes=19201
