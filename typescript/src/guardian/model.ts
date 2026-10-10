import { lunaModel } from "../models/models.js";

/** Execution and question reviews share the user's selected Guardian configuration. */
export const guardianModel = {
  model: lunaModel,
  modelSettings: { store: false, reasoning: { effort: "medium" as const } },
};
/**
 * A review's deadline in milliseconds: 600 s for a development public read, 240 s for a
 * publication review, which reads its whole evidence index, and 120 s for any other review.
 */
export const guardianReviewTimeout = (developmentPublicRead: boolean, publication = false) =>
  developmentPublicRead ? 600_000 : publication ? 240_000 : 120_000;
