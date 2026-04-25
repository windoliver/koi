// Pre-compiled trivial workflow for integration tests.
// Must use CommonJS-style exports — Temporal's webpack bundler resolves from here.
const { proxyActivities } = require("@temporalio/workflow");

const { noOp } = proxyActivities({
  startToCloseTimeout: "10 seconds",
});

async function trivialWorkflow() {
  return noOp();
}

Object.defineProperty(exports, "__esModule", { value: true });
exports.trivialWorkflow = trivialWorkflow;
