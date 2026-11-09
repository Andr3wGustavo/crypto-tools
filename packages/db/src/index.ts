import prismaPkg from '@prisma/client';
import type { PrismaClient as PrismaClientType } from '@prisma/client';

export type { Prisma } from '@prisma/client';
export type PrismaClient = PrismaClientType;

// Default import works for Prisma's CJS entry in every runtime (tsx, esbuild bundle, Node).
const { PrismaClient: PrismaClientCtor } = prismaPkg;

const globalRef = globalThis as unknown as { __cortexPrisma?: PrismaClientType };

/**
 * The single PrismaClient for the whole process. Never call `new PrismaClient()`
 * elsewhere: multiple clients multiply connection pools and caused lock contention in v2.
 */
export const prisma: PrismaClientType =
  globalRef.__cortexPrisma ?? new PrismaClientCtor({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalRef.__cortexPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
