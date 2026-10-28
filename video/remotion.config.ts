import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setConcurrency(4);
Config.setBrowserExecutable(process.env.REMOTION_CHROME ?? null);
