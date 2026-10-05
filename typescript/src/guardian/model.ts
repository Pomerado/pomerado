import { lunaModel } from "../models/models.js";

/** Execution and question reviews share the user's selected Guardian configuration. */
export const guardianModel = {
  model: lunaModel,
  modelSettings: { store: false, reasoning: { effort: "medium" as const } },
};
export const guardianReviewTimeout = (developmentPublicRead: boolean) =>
  developmentPublicRead ? 600_000 : 120_000;
