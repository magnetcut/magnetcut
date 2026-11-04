import type { MediaAssetData } from "@/services/storage/types";
import type { MediaFile } from "./disk-file";

export type MediaType = "image" | "video" | "audio";

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified" | "proxy"> {
	file: MediaFile;
	url?: string;
	proxy?: MediaProxy;
}

/** A video's small copy, which the preview plays instead when proxies are on. */
export interface MediaProxy {
	file: MediaFile;
	width: number;
	height: number;
}
