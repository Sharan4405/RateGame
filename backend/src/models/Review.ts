import { Schema, model, Types } from "mongoose";

export interface IReview {
  user_id: Types.ObjectId;
  game_id: Types.ObjectId;
  rating: number;
  comment?: string;
  created_at: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    game_id: { type: Schema.Types.ObjectId, ref: "Game", required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 10 },
    comment: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } }
);

export const Review = model<IReview>("Review", reviewSchema);
