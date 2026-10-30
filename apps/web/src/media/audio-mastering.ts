const MASTER_LIMITER_THRESHOLD_DB = -1;
const MASTER_LIMITER_KNEE_DB = 0;
const MASTER_LIMITER_RATIO = 20;
const MASTER_LIMITER_ATTACK_SECONDS = 0.001;
const MASTER_LIMITER_RELEASE_SECONDS = 0.12;
const MASTER_OUTPUT_HEADROOM = 0.98;

export function createAudioMasteringChain({
	audioContext,
	destination,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	destination: AudioNode;
}): {
	input: GainNode;
} {
	const input = audioContext.createGain();
	const limiter = audioContext.createDynamicsCompressor();
	const outputGain = audioContext.createGain();

	limiter.threshold.value = MASTER_LIMITER_THRESHOLD_DB;
	limiter.knee.value = MASTER_LIMITER_KNEE_DB;
	limiter.ratio.value = MASTER_LIMITER_RATIO;
	limiter.attack.value = MASTER_LIMITER_ATTACK_SECONDS;
	limiter.release.value = MASTER_LIMITER_RELEASE_SECONDS;
	outputGain.gain.value = MASTER_OUTPUT_HEADROOM;

	input.connect(limiter);
	limiter.connect(outputGain);
	outputGain.connect(destination);

	return { input };
}

/**
 * Masters part of a mix as playback does, through the limiter. Its first
 * `prerollLength` frames are the mix just before it, heard by the limiter but
 * not returned, so that parts mastered one after another join up as if the mix
 * had been mastered whole.
 */
export async function masterAudioStretch({
	audioBuffer,
	prerollLength,
}: {
	audioBuffer: AudioBuffer;
	prerollLength: number;
}): Promise<AudioBuffer> {
	const offlineContext = new OfflineAudioContext(
		audioBuffer.numberOfChannels,
		audioBuffer.length,
		audioBuffer.sampleRate,
	);
	const source = offlineContext.createBufferSource();
	source.buffer = audioBuffer;

	const { input } = createAudioMasteringChain({
		audioContext: offlineContext,
		destination: offlineContext.destination,
	});
	source.connect(input);
	source.start(0);

	const renderedBuffer = await offlineContext.startRendering();
	const stretch = new AudioBuffer({
		numberOfChannels: renderedBuffer.numberOfChannels,
		length: renderedBuffer.length - prerollLength,
		sampleRate: renderedBuffer.sampleRate,
	});
	for (let channel = 0; channel < stretch.numberOfChannels; channel++) {
		stretch.copyToChannel(
			renderedBuffer.getChannelData(channel).subarray(prerollLength),
			channel,
		);
	}
	clampAudioBufferPeak({
		audioBuffer: stretch,
		maxPeak: MASTER_OUTPUT_HEADROOM,
	});
	return stretch;
}

function clampAudioBufferPeak({
	audioBuffer,
	maxPeak,
}: {
	audioBuffer: AudioBuffer;
	maxPeak: number;
}): void {
	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			channelData[index] = Math.max(
				-maxPeak,
				Math.min(maxPeak, channelData[index]),
			);
		}
	}
}
