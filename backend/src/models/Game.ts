import { Schema, model } from "mongoose";

export interface IGame {
  name: string;
  genre: string[];
  release_year: Date;
  cover_image?: string;
  avg_rating: number;
  review_count: number;
}

const gameSchema = new Schema<IGame>(
  {
    name: { type: String, required: true, trim: true },
    genre: { type: [String], default: [], required: true },
    release_year: { type: Date, required: true },
    cover_image: { type: String },
    avg_rating: { type: Number, default: 0, min: 0, max: 10 },
    review_count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// Supports GET /api/games/search per the LLD (MongoDB $text index, no
// Elasticsearch yet — deferred until load numbers justify it)
gameSchema.index({ name: "text" });

export const Game = model<IGame>("Game", gameSchema);
