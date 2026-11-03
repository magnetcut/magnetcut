// Tiny H.264 streams for the tests, 32×32, made with ffmpeg and x264 from
// testsrc2 (the SEI with the encoder's settings taken out of the packets):
// high: High profile, CABAC, 2 B-frames, weighted P prediction, 5 frames;
// base: Constrained Baseline, CAVLC, 3 frames;
// full: High, full range, BT.709 primaries, transfer and matrix (avcC only).

export interface StreamFixture {
	avcC: string;
	packets: { type: "key" | "delta"; data: string }[];
}

export const STREAMS: Record<"high" | "base" | "full", StreamFixture> = {
	high: {
		avcC: "0164000affe100176764000aacd1096c0440000003004000000f03c489448001000668ebe3cb22c0fdf8f800",
		packets: [
			{
				type: "key",
				data: "0000016365888400efd2acfd78d9d39d8e00530ae2a3997d6aa3072aaa16ecafe688d6eeae676f41a84562909da4feae204ea4095c0a69001b7334a13970645a257b9f6f01a1438271e91bacabf470b1276c353150e26371c900eb217d042b5d737f4686d430ddcbe87dd550474a4a33f98ba1bf8258bf35863da210f0ef90974089bc9740b08ba9779795bd16a54857e268baec729cc4832cfb14e4743990c53aee8bed4087643f538d5b004849d2f48cd0c35b6a87fd6393e13ae154409d8e1f21afb7fbfc86981635f24577fd41c7541cf3967950ead6c4739b1ee0fde31749233d241a9fcf0d700355dc679ee5fb860c8d1904928a30da5b1f78ae028e43bedda69adb786ce5d3b76b836537c13260c432d401df348cfbbc693622a2cd5c55e32bfa635944f38b852a32175259271c190b4b923215042c86dc17037f3ca46fab83da3411440467253342abc41dfe370b2b38261d1eb7177484142e4fd2027018a0098e9fc1",
			},
			{ type: "delta", data: "00000008419a26d8853f6640" },
			{ type: "delta", data: "00000008019e42f218ffc481" },
			{ type: "delta", data: "00000008019e44f218ffc480" },
			{ type: "delta", data: "0000000c419a48784326530863ff7641" },
		],
	},
	base: {
		avcC: "0142c00affe100156742c00ad9096c0440000003004000000f03c4899201000568cb83cb20",
		packets: [
			{
				type: "key",
				data: "0000015c658884087c4222a00c0843f01d48007d9996640005accd228d07c9dfe0e843322a1119771565b9f05b23725387d9dfec0ea748e9a2bfe85ab8d0a91fcebad58b2f3ed5e8947b727a7a87a4a983f3fbe48b4ed85bb6f81000100c716140cc0800556491a088791e7835c2a38fc3cffe70a791434540bd6e8192dbd46194ffe0879782d0dfffb8e0acc7654697588c20d7614e3c000401f01644a955dcb48cb37c7ffe17f99915088cb004117229c3eddfe9d4c245515aeec332b468d6af50dd1283a5bfdb3a4b4c7907506b94ddea56e1e4546fad3b4e4c9a0ea91a742a48f36030001a40008060678d01bd104ffdec55c24b984b4d4814957f7d674dbd072b7ffb92eec8ed9cdfcb2ce029c651e1bc71ffce24bd24c9cffefc8007c21f868a4e5abfecf3c4400288040f262ee72545dc9200381ae3c0b01c0381ae1c0b1f8fff0d4f00023efecf1e0710800c18882f9e5559bb85a04c15bb83a04c40",
			},
			{ type: "delta", data: "00000006419a3814e580" },
			{ type: "delta", data: "00000006419a54063960" },
		],
	},
	full: {
		avcC: "0164000affe1001b6764000aacd9496c05b808080a000003000200000300781e244b2c01000668ebe3cb22c0fdf8f800",
		packets: [],
	},
};

export function fromHex({ hex }: { hex: string }): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
		Number.parseInt(pair, 16),
	);
}
