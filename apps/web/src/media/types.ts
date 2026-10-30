import type { MediaAssetData } from "@/services/storage/types";
import type { MediaFile } from "./disk-file";

export type MediaType = "image" | "video" | "audio";

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified"> {
	file: MediaFile;
	url?: string;
}
