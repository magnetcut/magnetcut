import type { Metadata } from "next";
import { SITE_INFO } from "@/site/brand";

export const baseMetaData: Metadata = {
	title: SITE_INFO.title,
	description: SITE_INFO.description,
	icons: {
		icon: SITE_INFO.favicon,
	},
};
