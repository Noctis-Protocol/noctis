#!/usr/bin/env ts-node
/**
 * @file Add keeper to NoctisVault
 * @description Adds a keeper using the 2-step timelock pattern
 * 
 * Usage:
 *   npx ts-node src/add-keeper.ts
 * 
 * Environment:
 *   - PRIVATE_KEY: Owner private key (vault owner)
 *   - VAULT_ADDRESS: NoctisVault contract address
 *   - KEEPER_PRIVATE_KEY: Keeper private key (to derive address)
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const VAULT_ABI = [
  'function owner() view returns (address)',
  'function isKeeper(address) view returns (bool)',
  'function getKeeperCount() view returns (uint256)',
  'function getKeeperAt(uint256) view returns (address)',
  'function keeperProposalCounter() view returns (uint256)',
  'function keeperChangeProposals(uint256) view returns (address keeper, uint256 newMinKeepers, uint8 operation, uint256 executeAfter, bool exists)',
  'function KEEPER_CHANGE_DELAY() view returns (uint256)',
  'function proposeAddKeeperV2(address keeper) external returns (uint256)',
  'function executeKeeperChangeV2(uint256 proposalId) external',
  'event KeeperChangeProposedV2(uint256 indexed proposalId, address indexed keeper, uint256 newMinKeepers, uint8 operation, uint256 executeAfter)',
  'event KeeperAdded(address indexed keeper, uint256 totalKeepers)',
];

async function main() {
  console.log('🔐 Noctis Vault - Add Keeper');
  console.log('═'.repeat(60));

  const rpcUrl = process.env.RPC_URL || process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
  const privateKey = process.env.PRIVATE_KEY;
  const vaultAddress = process.env.VAULT_ADDRESS;
  
  // Get keeper address from private key
  let keeperAddress = process.env.KEEPER_ADDRESS;
  if (!keeperAddress && process.env.KEEPER_PRIVATE_KEY) {
    const keeperWallet = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY);
    keeperAddress = keeperWallet.address;
  }

  if (!privateKey) {
    console.error('❌ PRIVATE_KEY not set (must be vault owner)');
    process.exit(1);
  }
  if (!vaultAddress) {
    console.error('❌ VAULT_ADDRESS not set');
    process.exit(1);
  }
  if (!keeperAddress) {
    console.error('❌ KEEPER_ADDRESS or KEEPER_PRIVATE_KEY not set');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const owner = new ethers.Wallet(privateKey, provider);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, owner);

  const network = await provider.getNetwork();
  console.log(`\nNetwork:  ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`Vault:    ${vaultAddress}`);
  console.log(`Owner:    ${owner.address}`);
  console.log(`Keeper:   ${keeperAddress}`);

  // Verify owner
  const vaultOwner = await vault.owner();
  if (vaultOwner.toLowerCase() !== owner.address.toLowerCase()) {
    console.error(`\n❌ You are not the vault owner!`);
    console.error(`   Vault owner: ${vaultOwner}`);
    process.exit(1);
  }
  console.log('\n✅ You are the vault owner');

  // Check if already keeper
  const isAlreadyKeeper = await vault.isKeeper(keeperAddress);
  if (isAlreadyKeeper) {
    console.log('✅ Keeper is already registered!');
    await showKeeperStatus(vault);
    return;
  }

  // Check for existing proposal
  const proposalCounter = await vault.keeperProposalCounter();
  let existingProposalId: bigint | null = null;
  
  for (let i = 1; i <= Number(proposalCounter); i++) {
    const proposal = await vault.keeperChangeProposals(i);
    if (proposal.exists && proposal.keeper.toLowerCase() === keeperAddress.toLowerCase()) {
      existingProposalId = BigInt(i);
      
      const now = Math.floor(Date.now() / 1000);
      const timeLeft = Number(proposal.executeAfter) - now;
      
      if (timeLeft > 0) {
        const hours = Math.floor(timeLeft / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        console.log(`\n⏳ Proposal #${i} exists - waiting for timelock`);
        console.log(`   Execute in: ${hours}h ${minutes}m`);
        console.log('\n   Run this script again after timelock expires.');
        return;
      } else {
        console.log(`\n✅ Proposal #${i} ready to execute!`);
        break;
      }
    }
  }

  if (existingProposalId !== null) {
    // Execute existing proposal
    console.log('\n🚀 Executing keeper addition...');
    const tx = await vault.executeKeeperChangeV2(existingProposalId);
    console.log(`   Tx: ${tx.hash}`);
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log('   ✅ Keeper added successfully!');
    } else {
      console.log('   ❌ Transaction failed');
      process.exit(1);
    }
  } else {
    // Create new proposal
    const delay = await vault.KEEPER_CHANGE_DELAY();
    const delayHours = Number(delay) / 3600;
    
    console.log(`\n📝 Creating keeper proposal...`);
    console.log(`   Timelock: ${delayHours} hours`);
    
    const tx = await vault.proposeAddKeeperV2(keeperAddress);
    console.log(`   Tx: ${tx.hash}`);
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      // Extract proposal ID
      let proposalId = proposalCounter + 1n;
      for (const log of receipt.logs) {
        try {
          const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === 'KeeperChangeProposedV2') {
            proposalId = parsed.args.proposalId;
            break;
          }
        } catch (e) {}
      }
      
      console.log(`   ✅ Proposal #${proposalId} created!`);
      console.log(`\n⏳ Wait ${delayHours} hours, then run this script again to execute.`);
    } else {
      console.log('   ❌ Transaction failed');
      process.exit(1);
    }
  }

  await showKeeperStatus(vault);
}

async function showKeeperStatus(vault: ethers.Contract) {
  console.log('\n' + '─'.repeat(60));
  console.log('📊 Keeper Status:');
  
  const count = await vault.getKeeperCount();
  console.log(`   Total: ${count.toString()}`);
  
  if (Number(count) > 0) {
    console.log('   Registered:');
    for (let i = 0; i < Number(count); i++) {
      const keeper = await vault.getKeeperAt(i);
      console.log(`     ${i + 1}. ${keeper}`);
    }
  }
  
  console.log('─'.repeat(60));
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
