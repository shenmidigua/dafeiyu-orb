/**
 * Loader shim, replacing the upstream `addon-static-import.js`.
 *
 * Upstream probes seven platform packages by relative path, and the probe happens at module load
 * rather than on demand: this copy ships exactly one Windows x64 addon, sitting in the same folder,
 * so naming it directly is the whole job. Kept as a separate file because `addon.cjs` requires it
 * before it tries its own search paths.
 */

module.exports = require('./sherpa-onnx.node')
