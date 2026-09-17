// Synthetic-only Web Audio probe. Serialize runNativeAudioProbe into a local
// document; it has no imports, permissions, external URLs, microphone or output.
export async function runNativeAudioProbe(options = {}) {
  const checks = {};
  const digest = async values => {
    const copy = new Float32Array(values);
    const bytes = await crypto.subtle.digest("SHA-256", copy.buffer);
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
  };
  const equal = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const graph = async (sampleRate, silent = false) => {
    const context = new OfflineAudioContext(2, 4096, sampleRate);
    let complete;
    const eventPromise = new Promise(resolve => { complete = resolve; });
    context.oncomplete = event => complete(event.renderedBuffer);
    if (!silent) {
      const oscillator = context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = 997;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -50;
      compressor.knee.value = 40;
      compressor.ratio.value = 12;
      compressor.attack.value = 0;
      compressor.release.value = 0.25;
      oscillator.connect(compressor);
      compressor.connect(context.destination);
      oscillator.start(0);
    }
    const result = await context.startRendering();
    let timeout;
    try {
      const completeBuffer = await Promise.race([eventPromise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Offline completion event timeout")), 5000); })]);
      return { context, result, completeBuffer };
    } finally { clearTimeout(timeout); }
  };
  const result = { api: { audioBuffer: typeof AudioBuffer, offlineAudioContext: typeof OfflineAudioContext }, checks, rates: {}, worker: null };
  checks.noPageSeedSetters = ["setAudioFingerprintSeed", "setFontSpacingSeed", "setCanvasSeed"].every(name => !(name in globalThis));
  if (typeof OfflineAudioContext !== "function" || typeof AudioBuffer !== "function") return result;

  const authored = new AudioBuffer({ length: 32, numberOfChannels: 2, sampleRate: 48000 });
  checks.authoredSilence = Array.from(authored.getChannelData(0)).every(value => Object.is(value, 0));
  const supplied = new Float32Array([-1, -0.25, -0, 0, 0.25, 1, Number.NaN, Number.POSITIVE_INFINITY]);
  authored.copyToChannel(supplied, 0, 3);
  const copiedAuthored = new Float32Array(supplied.length);
  authored.copyFromChannel(copiedAuthored, 0, 3);
  checks.authoredCopyExact = equal(Array.from(copiedAuthored), Array.from(supplied));
  checks.authoredGetExact = equal(Array.from(authored.getChannelData(0).slice(3, 3 + supplied.length)), Array.from(supplied));
  checks.otherChannelUntouched = Array.from(authored.getChannelData(1)).every(value => Object.is(value, 0));

  let workerTransfer;
  for (const sampleRate of [44100, 48000]) {
    const rendered = await graph(sampleRate);
    const buffer = rendered.result;
    const copiedFirst = new Float32Array(buffer.length);
    buffer.copyFromChannel(copiedFirst, 0);
    const partialFirst = new Float32Array(257);
    buffer.copyFromChannel(partialFirst, 0, 513);
    const direct = buffer.getChannelData(0);
    const repeated = buffer.getChannelData(0);
    const copiedAfter = new Float32Array(buffer.length);
    buffer.copyFromChannel(copiedAfter, 0);
    const initial = new Float32Array(direct);
    checks[`${sampleRate}.promiseEventSameBuffer`] = rendered.completeBuffer === buffer;
    checks[`${sampleRate}.rateLengthDuration`] = buffer.sampleRate === sampleRate && buffer.length === 4096 && buffer.duration === 4096 / sampleRate;
    checks[`${sampleRate}.contextClosed`] = rendered.context.state === "closed";
    checks[`${sampleRate}.copyBeforeGetEqualsGet`] = equal(Array.from(copiedFirst), Array.from(direct));
    checks[`${sampleRate}.copyAfterGetEqualsGet`] = equal(Array.from(copiedAfter), Array.from(direct));
    checks[`${sampleRate}.partialBeforeGetExact`] = equal(Array.from(partialFirst), Array.from(initial.slice(513, 770)));
    checks[`${sampleRate}.repeatedViewSameObject`] = repeated === direct;
    checks[`${sampleRate}.finiteRender`] = Array.from(initial).every(Number.isFinite);
    checks[`${sampleRate}.nonSilentRender`] = Array.from(initial).some(value => Math.abs(value) > 0.001);
    const sameGraph = (await graph(sampleRate)).result;
    const sameData = new Float32Array(sameGraph.length);
    sameGraph.copyFromChannel(sameData, 0);
    checks[`${sampleRate}.sameGraphStable`] = equal(Array.from(initial), Array.from(sameData));
    const unity = new OfflineAudioContext(2, sameGraph.length, sampleRate);
    const unitySource = unity.createBufferSource();
    unitySource.buffer = sameGraph;
    unitySource.connect(unity.destination);
    unitySource.start();
    const unityBuffer = await unity.startRendering();
    const unityData = new Float32Array(unityBuffer.length);
    unityBuffer.copyFromChannel(unityData, 0);
    let unityMaxAbsError = 0;
    for (let index = 0; index < unityData.length; index++) unityMaxAbsError = Math.max(unityMaxAbsError, Math.abs(unityData[index] - initial[index]));
    checks[`${sampleRate}.unityRenderedReplayExact`] = equal(Array.from(unityData), Array.from(initial));
    const partialLater = new Float32Array(257);
    buffer.copyFromChannel(partialLater, 0, 513);
    checks[`${sampleRate}.partialReadOrderStable`] = equal(Array.from(partialFirst), Array.from(partialLater));
    const silence = (await graph(sampleRate, true)).result;
    const silentCopy = new Float32Array(silence.length);
    silence.copyFromChannel(silentCopy, 0);
    checks[`${sampleRate}.renderedSilenceExact`] = Array.from(silentCopy).every(value => Object.is(value, 0));

    // Authored writes into a rendered buffer must not be transformed on a later
    // get/copy read, even if the completed render had native perturbation.
    direct[5] = 0.125;
    const copiedWrite = new Float32Array(1);
    buffer.copyFromChannel(copiedWrite, 0, 5);
    checks[`${sampleRate}.directWriteVisible`] = Object.is(copiedWrite[0], 0.125);
    const write = new Float32Array([-0.5, 0, 0.5]);
    buffer.copyToChannel(write, 0, 17);
    checks[`${sampleRate}.copyToVisible`] = equal(Array.from(buffer.getChannelData(0).slice(17, 20)), Array.from(write));
    const expectedOverlap = new Float32Array(buffer.getChannelData(0));
    expectedOverlap.copyWithin(110, 100, 180);
    buffer.copyToChannel(buffer.getChannelData(0).subarray(100, 180), 0, 110);
    checks[`${sampleRate}.overlappingCopyExact`] = equal(Array.from(buffer.getChannelData(0)), Array.from(expectedOverlap));
    const beforeAcquire = new Float32Array(buffer.getChannelData(0));
    const replay = new OfflineAudioContext(2, buffer.length, sampleRate);
    const source = replay.createBufferSource();
    source.buffer = buffer;
    source.connect(replay.destination);
    source.start();
    const replayBuffer = await replay.startRendering();
    checks[`${sampleRate}.acquireRestoreNoSecondTransform`] = equal(Array.from(buffer.getChannelData(0)), Array.from(beforeAcquire));
    const replayData = new Float32Array(replayBuffer.length);
    replayBuffer.copyFromChannel(replayData, 0);
    let authoredReplayMaxAbsError = 0;
    for (let index = 0; index < replayData.length; index++) authoredReplayMaxAbsError = Math.max(authoredReplayMaxAbsError, Math.abs(replayData[index] - beforeAcquire[index]));
    const unityErrorBudget = options.maxUnityError ?? 0.000001;
    checks[`${sampleRate}.authoredReplayErrorBounded`] = Number.isFinite(authoredReplayMaxAbsError) && authoredReplayMaxAbsError <= unityErrorBudget;
    result.rates[sampleRate] = { sha256: await digest(initial), copySha256: await digest(copiedFirst), partialSha256: await digest(partialFirst), samples: initial.length, unityMaxAbsError, authoredReplayMaxAbsError, unityErrorBudget };
    if (sampleRate === 44100) workerTransfer = initial;
  }

  // Standard Web Audio constructors are Window-only. Workers must not acquire
  // fabricated APIs; transferred PCM must remain bit-for-bit unchanged.
  const workerSource = `onmessage = async event => { const data = event.data; const hash = await crypto.subtle.digest('SHA-256', data); postMessage({audioBuffer:typeof AudioBuffer,offlineAudioContext:typeof OfflineAudioContext,audioContext:typeof AudioContext,sha256:Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('')}); };`;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  let timer;
  try {
    result.worker = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Audio transfer worker timeout")), 5000);
      worker.onmessage = event => resolve(event.data);
      worker.onerror = () => reject(new Error("Audio transfer worker failed"));
      const transferred = new Float32Array(workerTransfer).buffer;
      worker.postMessage(transferred, [transferred]);
    });
    checks.workerApiShapeNative = result.worker.audioBuffer === "undefined" && result.worker.offlineAudioContext === "undefined" && result.worker.audioContext === "undefined";
    checks.workerTransferExact = result.worker.sha256 === result.rates[44100].sha256;
  } finally { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(workerUrl); }
  return result;
}

export function compareNativeAudioMatrix(observations, { requireSeedEffect = false } = {}) {
  const issues = [];
  if (!observations["A:page:first"]) issues.push({ label: "A:page:first", check: "reference-observation-missing" });
  for (const [label, observation] of Object.entries(observations)) {
    if (!observation || observation.error) { issues.push({ label, check: "probe-completed", actual: observation?.error ?? "missing" }); continue; }
    if (observation.api?.audioBuffer !== "function" || observation.api?.offlineAudioContext !== "function") issues.push({ label, check: "window-audio-api-available" });
    const required = ["noPageSeedSetters", "authoredSilence", "authoredCopyExact", "authoredGetExact", "otherChannelUntouched", "workerApiShapeNative", "workerTransferExact"];
    for (const rate of [44100, 48000]) for (const check of ["promiseEventSameBuffer", "rateLengthDuration", "contextClosed", "copyBeforeGetEqualsGet", "copyAfterGetEqualsGet", "partialBeforeGetExact", "repeatedViewSameObject", "finiteRender", "nonSilentRender", "sameGraphStable", "unityRenderedReplayExact", "partialReadOrderStable", "renderedSilenceExact", "directWriteVisible", "copyToVisible", "overlappingCopyExact", "acquireRestoreNoSecondTransform", "authoredReplayErrorBounded"]) required.push(`${rate}.${check}`);
    for (const check of required) if (!(check in (observation.checks ?? {}))) issues.push({ label, check: `${check}.missing` });
    for (const rate of [44100, 48000]) {
      const values = observation.rates?.[rate];
      if (values?.samples !== 4096 || !/^[a-f0-9]{64}$/.test(values?.sha256 ?? "") || !/^[a-f0-9]{64}$/.test(values?.copySha256 ?? "")) issues.push({ label, check: `${rate}.render-data-missing` });
    }
    for (const [check, passed] of Object.entries(observation.checks ?? {})) if (passed !== true) issues.push({ label, check });
  }
  const reference = observations["A:page:first"];
  for (const [label, observation] of Object.entries(observations)) {
    if (!label.startsWith("A:") || !reference?.rates || !observation?.rates) continue;
    for (const sampleRate of [44100, 48000]) if (reference.rates[sampleRate]?.sha256 !== observation.rates[sampleRate]?.sha256) issues.push({ label, check: `${sampleRate}.profile-realm-restart-stability` });
  }
  const other = observations["B:page:first"];
  const seedEffect = Boolean(reference?.rates && other?.rates && [44100, 48000].some(rate => reference.rates[rate]?.sha256 !== other.rates[rate]?.sha256));
  if (requireSeedEffect && !seedEffect) issues.push({ label: "A/B", check: "configured-native-seed-effect-not-observed" });
  return { passed: issues.length === 0, seedEffect, issues };
}
