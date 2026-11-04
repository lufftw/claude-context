/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Fork tests live under __tests__/; upstream tests sit next to the source (src/**/*.test.ts).
  testMatch: ['**/__tests__/**/*.test.ts', '<rootDir>/src/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 15000,
};
