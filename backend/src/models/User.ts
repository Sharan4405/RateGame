import { Schema, model } from "mongoose";

export interface IUser {
  username: string;
  email: string;
  password_hash: string;
  review_count: number;
}

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    review_count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

export const User = model<IUser>("User", userSchema);
