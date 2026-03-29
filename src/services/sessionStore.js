/**
 * Simple in-memory store for active call sessions.
 * In production, replace with Redis for multi-instance support.
 */
export const sessionStore = new Map();
