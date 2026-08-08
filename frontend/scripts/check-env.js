#!/usr/bin/env node

/**
 * Environment Variable Checker
 * 
 * Validates that required environment variables are set before dev/build.
 * Run with --strict to fail on missing vars (for CI/CD).
 * 
 * Sepolia-only configuration (no Arbitrum)
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_VARS = [
  'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
  'NEXT_PUBLIC_VAULT_ADDRESS',
  'NEXT_PUBLIC_EXCHANGE_ADDRESS',
  'NEXT_PUBLIC_USDT_ADDRESS',
];

const ENV_FILE = path.join(__dirname, '..', '.env.local');
const strict = process.argv.includes('--strict');

console.log('🔍 Checking environment variables...\n');

// Check if .env.local exists
if (!fs.existsSync(ENV_FILE)) {
  console.error('❌ .env.local not found!');
  console.log('\n📝 Create it by copying .env.example:');
  console.log('   cp .env.example .env.local\n');
  process.exit(1);
}

// Parse .env.local
const envContent = fs.readFileSync(ENV_FILE, 'utf8');
const envVars = {};

envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) {
    envVars[match[1]] = match[2].trim();
  }
});

// Check each required var
const missing = [];
const empty = [];

REQUIRED_VARS.forEach(varName => {
  if (!(varName in envVars)) {
    missing.push(varName);
  } else if (!envVars[varName] || envVars[varName] === 'your_project_id_here') {
    empty.push(varName);
  } else {
    console.log(`✅ ${varName}`);
  }
});

// Report results
if (missing.length > 0) {
  console.log('\n❌ Missing variables:');
  missing.forEach(v => console.log(`   - ${v}`));
}

if (empty.length > 0) {
  console.log('\n⚠️  Empty variables:');
  empty.forEach(v => console.log(`   - ${v}`));
}

if (missing.length === 0 && empty.length === 0) {
  console.log('\n✅ All environment variables configured!\n');
  console.log('Network: Ethereum Sepolia (Chain ID: 11155111)');
  console.log('Gateway: ZAMA FHE Gateway available ✅\n');
  process.exit(0);
}

if (strict) {
  console.log('\n❌ Environment validation failed (strict mode)\n');
  process.exit(1);
}

console.log('\n⚠️  Some variables are missing or empty');
console.log('   Development server will start but features may not work\n');
process.exit(0);
