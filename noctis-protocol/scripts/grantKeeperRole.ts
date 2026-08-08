import { ethers } from 'hardhat';

async function main() {
  const EXCHANGE = '0x9C6d80c7eac843e0dD148d12959946Db2AA67CC6';
  const KEEPER = '0x0A8141174241824a0244889C6f846c3975aad8F7';
  
  const exchange = await ethers.getContractAt('NoctisExchange', EXCHANGE);
  
  // Grant KEEPER_MANAGER_ROLE to deployer first
  const KEEPER_MANAGER_ROLE = await exchange.KEEPER_MANAGER_ROLE();
  const [deployer] = await ethers.getSigners();
  
  console.log('👤 Deployer:', deployer.address);
  console.log('🔑 KEEPER_MANAGER_ROLE:', KEEPER_MANAGER_ROLE);
  
  // Check if deployer has role
  const hasRole = await exchange.hasRole(KEEPER_MANAGER_ROLE, deployer.address);
  console.log('📋 Deployer has KEEPER_MANAGER_ROLE:', hasRole);
  
  if (!hasRole) {
    console.log('❌ Deployer needs KEEPER_MANAGER_ROLE first');
    console.log('   Admin must grant it or use DEFAULT_ADMIN_ROLE');
    
    // Try with DEFAULT_ADMIN_ROLE
    const DEFAULT_ADMIN_ROLE = await exchange.DEFAULT_ADMIN_ROLE();
    const isAdmin = await exchange.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
    console.log('📋 Deployer is DEFAULT_ADMIN:', isAdmin);
    
    if (isAdmin) {
      console.log('✅ Granting KEEPER_MANAGER_ROLE to deployer...');
      const grantTx = await exchange.grantRole(KEEPER_MANAGER_ROLE, deployer.address);
      await grantTx.wait();
      console.log('✅ Role granted!');
    }
  }
  
  // Now add keeper
  console.log('\n🔑 Adding keeper:', KEEPER);
  const tx = await exchange.addKeeper(KEEPER);
  console.log('⏳ Transaction:', tx.hash);
  
  await tx.wait();
  console.log('✅ Keeper added successfully!');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
