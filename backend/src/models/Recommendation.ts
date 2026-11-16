import { Schema, model, Types } from "mongoose";

export interface IRecommendation {
  user_id: Types.ObjectId;
  recommended_game_ids: Types.ObjectId[];
  computed_at: Date;
  review_count_at_last_update: number;
}

const recommendationSchema = new Schema<IRecommendation>({
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  recommended_game_ids: [{ type: Schema.Types.ObjectId, ref: "Game" }],
  computed_at: { type: Date, default: Date.now },
  review_count_at_last_update: { type: Number, default: 0 },
});

export const Recommendation = model<IRecommendation>("Recommendation", recommendationSchema);
