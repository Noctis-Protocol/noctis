#!/bin/bash

# 🚀 SCRIPT AUTOMATIQUE - Configuration Testnet
# Ce script crée ton fichier .env pour déployer sur Arbitrum Sepolia

echo "🔧 Configuration Testnet Noctis - Arbitrum Sepolia"
echo "=================================================="
echo ""

# Check if .env already exists
if [ -f ".env" ]; then
    echo "⚠️  Le fichier .env existe déjà!"
    echo ""
    read -p "Veux-tu le remplacer? (y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Annulé. Fichier .env non modifié."
        exit 0
    fi
    mv .env .env.backup
    echo "✅ Ancien .env sauvegardé dans .env.backup"
fi

# Get private key
echo ""
echo "🔑 Configuration de ta clé privée testnet"
echo ""
echo "⚠️  IMPORTANT:"
echo "   - Utilise un wallet TESTNET séparé"
echo "   - NE PAS utiliser ton wallet mainnet"
echo "   - La clé doit commencer par 0x"
echo ""
read -p "Entre ta PRIVATE_KEY testnet (0x...): " PRIVATE_KEY

# Validate private key format
if [[ ! $PRIVATE_KEY =~ ^0x[a-fA-F0-9]{64}$ ]]; then
    echo ""
    echo "❌ Format invalide! La clé doit:"
    echo "   - Commencer par 0x"
    echo "   - Contenir 64 caractères hexadécimaux"
    echo ""
    echo "Exemple: 0x1234567890abcdef..."
    exit 1
fi

# Optional: Arbiscan API Key
echo ""
echo "📝 Arbiscan API Key (optionnel, pour vérifier les contrats)"
echo "   Laisse vide si tu n'en as pas (tu peux l'ajouter plus tard)"
echo ""
read -p "Arbiscan API Key (ou appuie sur Entrée): " ARBISCAN_KEY

# Create .env file
cat > .env << EOF
# ============================================
# NOCTIS TESTNET CONFIGURATION
# ============================================
# Generated: $(date)
# Network: Arbitrum Sepolia (Chain ID: 421614)

# ============================================
# WALLET (TESTNET ONLY!)
# ============================================
PRIVATE_KEY=$PRIVATE_KEY

# ============================================
# RPC ENDPOINTS
# ============================================
ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
ARBITRUM_ONE_RPC=https://arb1.arbitrum.io/rpc

# ============================================
# BLOCK EXPLORER (OPTIONAL)
# ============================================
ARBISCAN_API_KEY=$ARBISCAN_KEY

# ============================================
# GAS REPORTING (OPTIONAL)
# ============================================
REPORT_GAS=false
COINMARKETCAP_API_KEY=

# ============================================
# SAFETY
# ============================================
EXPECTED_CHAIN_ID=421614
EOF

# Set correct permissions
chmod 600 .env

echo ""
echo "✅ Fichier .env créé avec succès!"
echo ""
echo "📋 PROCHAINES ÉTAPES:"
echo ""
echo "1. ✅ .env configuré"
echo "2. ⏳ Obtenir du testnet ETH"
echo "   → https://www.alchemy.com/faucets/arbitrum-sepolia"
echo "3. ⏳ Déployer les contrats"
echo "   → npx hardhat run scripts/deployTestnetWithMocks.ts --network arbitrumSepolia"
echo ""
echo "⚠️  SÉCURITÉ:"
echo "   - Le fichier .env est dans .gitignore (ne sera pas commit)"
echo "   - Permissions 600 (seul toi peut le lire)"
echo "   - Ne JAMAIS partager ta clé privée"
echo ""
echo "🚀 Ready to deploy!"
