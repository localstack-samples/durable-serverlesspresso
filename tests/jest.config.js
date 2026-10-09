/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/integration'],
  setupFiles: ['<rootDir>/src/env.ts'],
  testTimeout: 120000,
};
