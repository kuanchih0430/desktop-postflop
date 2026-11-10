import type { useConfigStore } from "./store";

export type RunSettings = {
  numThreads: number;
  targetExploitability: number;
  maxIterations: number;
};

export type SolverSetup = {
  config: ReturnType<typeof useConfigStore>["$state"];
  ranges: [number[], number[]];
  rangeTexts: [string, string];
  compressionEnabled: boolean;
};

export type RunStats = {
  iterations: number;
  exploitability: number;
  elapsedTimeMs: number;
  stoppedEarly: boolean;
  runSettings?: RunSettings | null;
};

export type ResultMetadata = RunStats & {
  formatVersion: number;
  board: number[];
  startingPot: number;
  effectiveStack: number;
  solverSetup?: SolverSetup;
};
