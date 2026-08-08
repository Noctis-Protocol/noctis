#!/usr/bin/env ts-node
/**
 * @file Check NoctisVault status
 * @description Displays current vault configuration: keepers, gateway, pending proposals
 * 
 * Usage:
 *   npx ts-node src/check-vault.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const VAULT_ABI = [
  'function owner() view returns (address)',
  'function isKeeper(address) view returns (bool)',
  'function getKeeperCount() view returns (uint256)',
  'function getKeeperAt(uint256) view returns (address)',
  'function minKeepers() view returns (uint256)',
  'function gateway() view returns (address)',
  'function isGatewayConfigured() view returns (bool)',
  'function pendingGateway() view returns (address)',
  'function keeperProposalCounter() view returns (uint256)',
  'function keeperChangeProposals(uint256) view returns (address keeper, uint256 newMinKeepers, uint8 operation, uint256 executeAfter, bool exists)',
  'function KEEPER_CHANGE_DELAY() view returns (uint256)',
  'function paused() view returns (bool)',
  'function withdrawalRequestCounter() view returns (uint256)',
];

const OPERATION_NAMES = ['ADD', 'REMOVE', 'SET_MIN'];

async function main() {
  console.log('🔍 Noctis Vault - Status Check');
  console.log('═'.repeat(70));

  const rpcUrl = process.env.RPC_URL || process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
  const vaultAddress = process.env.VAULT_ADDRESS;

  if (!vaultAddress) {
    console.error('❌ VAULT_ADDRESS not set');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

  const network = await provider.getNetwork();
  console.log(`\n📡 Network: ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`📋 Vault:   ${vaultAddress}`);

  // Check if contract exists
  const code = await provider.getCode(vaultAddress);
  if (code === '0x') {
    console.error('\n❌ No contract found at this address!');
    process.exit(1);
  }

  // Basic info
  console.log('\n' + '─'.repeat(70));
  console.log('📊 BASIC INFO');
  console.log('─'.repeat(70));
  
  const owner = await vault.owner();
  const paused = await vault.paused();
  const delay = await vault.KEEPER_CHANGE_DELAY();
  
  console.log(`Owner:           ${owner}`);
  console.log(`Paused:          ${paused ? '🔴 YES' : '🟢 NO'}`);
  console.log(`Timelock Delay:  ${Number(delay) / 3600} hours`);

  // Gateway status
  console.log('\n' + '─'.repeat(70));
  console.log('🌐 GATEWAY STATUS');
  console.log('─'.repeat(70));
  
  const gateway = await vault.gateway();
  const isGatewayConfigured = await vault.isGatewayConfigured();
  
  console.log(`Configured:      ${isGatewayConfigured ? '✅ YES' : '❌ NO'}`);
  console.log(`Gateway Address: ${gateway === ethers.ZeroAddress ? '(not set)' : gateway}`);

  // Keepers
  console.log('\n' + '─'.repeat(70));
  console.log('🔐 KEEPERS');
  console.log('─'.repeat(70));
  
  const keeperCount = await vault.getKeeperCount();
  const minKeepers = await vault.minKeepers();
  
  console.log(`Total:           ${keeperCount.toString()}`);
  console.log(`Minimum Required: ${minKeepers.toString()}`);
  
  if (Number(keeperCount) > 0) {
    console.log('\nRegistered Keepers:');
    for (let i = 0; i < Number(keeperCount); i++) {
      const keeper = await vault.getKeeperAt(i);
      console.log(`  ${i + 1}. ${keeper}`);
    }
  } else {
    console.log('\n⚠️  No keepers registered! Withdrawals cannot be processed.');
  }

  // Pending proposals
  console.log('\n' + '─'.repeat(70));
  console.log('📋 PENDING KEEPER PROPOSALS');
  console.log('─'.repeat(70));
  
  const proposalCounter = await vault.keeperProposalCounter();
  let pendingCount = 0;
  
  if (Number(proposalCounter) > 0) {
    const now = Math.floor(Date.now() / 1000);
    
    for (let i = 1; i <= Number(proposalCounter); i++) {
      const proposal = await vault.keeperChangeProposals(i);
      
      if (proposal.exists) {
        pendingCount++;
        const operation = OPERATION_NAMES[proposal.operation] || `UNKNOWN`;
        const executeAfter = Number(proposal.executeAfter);
        const timeLeft = executeAfter - now;
        
        console.log(`\nProposal #${i}:`);
        console.log(`  Operation:   ${operation}`);
        
        if (proposal.operation === 0 || proposal.operation === 1) {
          console.log(`  Keeper:      ${proposal.keeper}`);
        }
        
        if (timeLeft > 0) {
          const hours = Math.floor(timeLeft / 3600);
          const minutes = Math.floor((timeLeft % 3600) / 60);
          console.log(`  Execute In:  ${hours}h ${minutes}m`);
          console.log(`  Status:      ⏳ Waiting for timelock`);
        } else {
          console.log(`  Status:      ✅ Ready to execute!`);
        }
      }
    }
  }
  
  if (pendingCount === 0) {
    console.log('No pending proposals');
  }

  // Withdrawal stats
  console.log('\n' + '─'.repeat(70));
  console.log('💸 WITHDRAWAL STATS');
  console.log('─'.repeat(70));
  
  const withdrawalCounter = await vault.withdrawalRequestCounter();
  console.log(`Total Requests:  ${withdrawalCounter.toString()}`);

  // Check keeper from env
  if (process.env.KEEPER_PRIVATE_KEY) {
    const keeperWallet = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY);
    const isKeeper = await vault.isKeeper(keeperWallet.address);
    
    console.log('\n' + '─'.repeat(70));
    console.log('🔑 YOUR KEEPER STATUS');
    console.log('─'.repeat(70));
    console.log(`Address:         ${keeperWallet.address}`);
    console.log(`Is Registered:   ${isKeeper ? '✅ YES' : '❌ NO'}`);
    
    if (!isKeeper) {
      console.log('\n💡 To register, run: npm run add-keeper');
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(70));
  
  const issues: string[] = [];
  if (!isGatewayConfigured) issues.push('Gateway not configured');
  if (Number(keeperCount) === 0) issues.push('No keepers registered');
  if (paused) issues.push('Vault is paused');
  
  if (issues.length > 0) {
    console.log('⚠️  ISSUES:');
    issues.forEach(issue => console.log(`   - ${issue}`));
  } else {
    console.log('✅ Vault is ready for withdrawals!');
  }
  
  console.log('═'.repeat(70));
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
