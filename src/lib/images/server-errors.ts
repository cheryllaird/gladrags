/** Thrown by ServerImageProcessor when bytes can't be decoded as an accepted image. */
export class InvalidImageError extends Error {
  constructor(message = "That file isn't a readable image") {
    super(message);
    this.name = "InvalidImageError";
  }
}
