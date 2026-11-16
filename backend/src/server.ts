import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { rateLimiter } from "./services/rateLimiter.js";

dotenv.config();

const app = express();
const port = process.env.PORT;
const frontendUrl = process.env.FRONTEND_URL;

app.use(
  cors({
    origin: frontendUrl,
  })
);

app.use(rateLimiter);
app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send("Hello");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
