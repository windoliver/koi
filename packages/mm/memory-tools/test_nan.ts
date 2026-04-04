import { parseOptionalNumber } from "./src/parse-args.js";

const result1 = parseOptionalNumber({ n: NaN }, "n");
console.log("NaN:", result1);

const result2 = parseOptionalNumber({ n: Infinity }, "n");
console.log("Infinity:", result2);
