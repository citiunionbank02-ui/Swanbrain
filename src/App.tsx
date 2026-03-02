import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionProvider, WalletProvider, useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction, createTransferInstruction } from '@solana/spl-token';
import { Zap, Coins, ArrowRightLeft, RefreshCw, Terminal, Menu, Wallet, Sparkles } from 'lucide-react';

interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoURI: string;
  isNative?: boolean;
}

interface FormattedAccount {
  pubkey: string;
  mint: string;
  amount: bigint;
  uiAmount: number;
  decimals: number;
  symbol: string;
  name: string;
  logoURI: string;
  isNative: boolean;
  isAssociated: boolean;
}

interface AppLog {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
  timestamp: string;
}

const NETWORK = import.meta.env.VITE_SOLANA_NETWORK || 'mainnet';
const HELIUS_API_KEY = import.meta.env.VITE_HELIUS_API_KEY || '';
const RPC_ENDPOINT = HELIUS_API_KEY ? `https://${NETWORK}.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : import.meta.env.VITE_RPC_ENDPOINT || `https://api.${NETWORK}.solana.com`;

const fmtSOL = (n: number) => `◎${n?.toFixed(4) || '0.0000'}`;
const fmtToken = (n: bigint, decimals = 6) => (Number(n) / Math.pow(10, decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 });
const shortenAddress = (addr: string | null) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';

function ApexBotDashboard() {
    const { connection } = useConnection();
    const { publicKey, sendTransaction, connected } = useWallet();
    const [activeTab, setActiveTab] = useState("wallet");
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [jupiterMap, setJupiterMap] = useState<Map<string, TokenInfo>>(new Map());
    const [solBalance, setSolBalance] = useState(0);
    const [tokenAccounts, setTokenAccounts] = useState<FormattedAccount[]>([]);
    const [wrappedSolBalance, setWrappedSolBalance] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [logs, setLogs] = useState<AppLog[]>([]);
    const [showWrapModal, setShowWrapModal] = useState(false);
    const [showUnwrapModal, setShowUnwrapModal] = useState(false);
    const [wrapAmount, setWrapAmount] = useState('');
    const [transferAmount, setTransferAmount] = useState('');
    const [transferDest, setTransferDest] = useState('');
    const [selectedTokenAccount, setSelectedTokenAccount] = useState<FormattedAccount | null>(null);
    const logsEndRef = useRef<HTMLDivElement>(null);

    const addLog = useCallback((message: string, type: AppLog['type'] = 'info') => {
        setLogs(prev => [{ id: Date.now(), message, type, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
    }, []);

    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    useEffect(() => {
        const fetchJupiterTokens = async () => {
            try {
                const response = await fetch('https://tokens.jup.ag/tokens?tags=verified');
                const data = await response.json();
                const map = new Map<string, TokenInfo>();
                map.set(NATIVE_MINT.toBase58(), { symbol: "SOL", name: "Solana", address: NATIVE_MINT.toBase58(), decimals: 9, logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png", isNative: true });
                data.forEach((token: any) => {
                    map.set(token.address, { symbol: token.symbol, name: token.name, address: token.address, decimals: token.decimals, logoURI: token.logoURI });
                });
                setJupiterMap(map);
            } catch (error) {
                addLog("Failed to load Jupiter fallback list", 'warning');
            }
        };
        fetchJupiterTokens();
    }, [addLog]);

    const refreshAllBalances = useCallback(async () => {
        if (!publicKey) return;
        try {
            setIsLoading(true);
            const balance = await connection.getBalance(publicKey);
            setSolBalance(balance / LAMPORTS_PER_SOL);
            const response = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });
            const activeAccounts = response.value.filter(acc => BigInt(acc.account.data.parsed.info.tokenAmount.amount) > 0n);
            const mintAddresses = activeAccounts.map(acc => acc.account.data.parsed.info.mint);
            const metadataMap = new Map<string, { symbol: string; name: string; logoURI: string }>();
            if (HELIUS_API_KEY && mintAddresses.length > 0) {
                try {
                    addLog('Fetching live token metadata via Helius DAS...', 'info');
                    const heliusRes = await fetch(RPC_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'apex-bot', method: 'getAssetBatch', params: { ids: mintAddresses } }) });
                    const { result } = await heliusRes.json();
                    if (result && Array.isArray(result)) {
                        result.forEach(asset => {
                            if (asset && asset.id) {
                                const meta = asset.content?.metadata;
                                const links = asset.content?.links;
                                const image = links?.image || (asset.content?.files?.[0]?.uri) || '';  
                                metadataMap.set(asset.id, { symbol: meta?.symbol || 'UNKNOWN', name: meta?.name || shortenAddress(asset.id), logoURI: image });
                            }
                        });
                    }
                } catch (err) {
                    addLog('Helius metadata fetch failed, falling back to Jupiter', 'warning');
                }
            }

            const formattedAccounts: FormattedAccount[] = activeAccounts.map(acc => {
                const parsed = acc.account.data.parsed.info;
                const mint = parsed.mint;
                const heliusData = metadataMap.get(mint);
                const jupiterData = jupiterMap.get(mint);
                return {
                    pubkey: acc.pubkey.toBase58(),
                    mint: mint,
                    amount: BigInt(parsed.tokenAmount.amount),
                    uiAmount: parsed.tokenAmount.uiAmount,
                    decimals: parsed.tokenAmount.decimals,
                    symbol: heliusData?.symbol !== 'UNKNOWN' ? (heliusData?.symbol || jupiterData?.symbol || 'UNKNOWN') : (jupiterData?.symbol || 'UNKNOWN'),
                    name: heliusData?.name || jupiterData?.name || shortenAddress(mint),
                    logoURI: heliusData?.logoURI || jupiterData?.logoURI || '',
                    isNative: mint === NATIVE_MINT.toBase58(),
                    isAssociated: true,
                };
            });

            const wrappedSOL = formattedAccounts.find(a => a.isNative);
            setWrappedSolBalance(wrappedSOL ? wrappedSOL.uiAmount : 0);
            setTokenAccounts(formattedAccounts);
            addLog('Balances and metadata refreshed successfully', 'success');
        } catch (error: any) {
            addLog(`Balance refresh failed: ${error.message}`, 'error');
        } finally {
            setIsLoading(false);
        }
    }, [connection, publicKey, jupiterMap, addLog]);

    useEffect(() => {
        if (connected) {
            addLog(`Wallet Connected: ${shortenAddress(publicKey?.toBase58() || '')}`, 'success');
            refreshAllBalances();
        } else {
            setSolBalance(0);
            setTokenAccounts([]);
            setWrappedSolBalance(0);
        }
    }, [connected, publicKey, refreshAllBalances, addLog]);

    const wrapSOL = useCallback(async () => {
        if (!publicKey || !wrapAmount) return;
        try {
            setIsLoading(true);
            addLog('Initiating SOL wrap...', 'info');
            const amount = Math.floor(parseFloat(wrapAmount) * LAMPORTS_PER_SOL);
            const ata = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
            const transaction = new Transaction();
            const ataAccount = await connection.getAccountInfo(ata);
            if (!ataAccount) {
                transaction.add(createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, NATIVE_MINT));
            }
            transaction.add(SystemProgram.transfer({
                fromPubkey: publicKey,
                toPubkey: ata,
                lamports: amount,
            }));
            transaction.add(createSyncNativeInstruction(ata));
            const sig = await sendTransaction(transaction, connection);
            await connection.confirmTransaction(sig);
            addLog(`Successfully wrapped ${wrapAmount} SOL`, 'success');
            setWrapAmount('');
            setShowWrapModal(false);
            refreshAllBalances();
        } catch (error: any) {
            addLog(`Wrap failed: ${error.message}`, 'error');
        } finally {
            setIsLoading(false);
        }
    }, [publicKey, wrapAmount, connection, sendTransaction, addLog, refreshAllBalances]);

    const unwrapSOL = useCallback(async () => {
        if (!publicKey || !wrappedSolBalance) return;
        try {
            setIsLoading(true);
            addLog('Initiating SOL unwrap...', 'info');
            const ata = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
            const transaction = new Transaction();
            transaction.add(createCloseAccountInstruction(ata, publicKey, publicKey));
            const sig = await sendTransaction(transaction, connection);
            await connection.confirmTransaction(sig);
            addLog(`Successfully unwrapped wSOL`, 'success');
            setShowUnwrapModal(false);
            refreshAllBalances();
        } catch (error: any) {
            addLog(`Unwrap failed: ${error.message}`, 'error');
        } finally {
            setIsLoading(false);
        }
    }, [publicKey, wrappedSolBalance, connection, sendTransaction, addLog, refreshAllBalances]);

    const transferToken = useCallback(async () => {
        if (!publicKey || !selectedTokenAccount || !transferAmount || !transferDest) return;
        try {
            setIsLoading(true);
            addLog(`Transferring ${transferAmount} ${selectedTokenAccount.symbol}...`, 'info');
            const destinationPubkey = new PublicKey(transferDest);
            const amount = BigInt(Math.floor(parseFloat(transferAmount) * Math.pow(10, selectedTokenAccount.decimals)));
            const destinationAta = await getAssociatedTokenAddress(new PublicKey(selectedTokenAccount.mint), destinationPubkey);
            const transaction = new Transaction();
            const destAta = await connection.getAccountInfo(destinationAta);
            if (!destAta) {
                transaction.add(createAssociatedTokenAccountInstruction(publicKey, destinationAta, destinationPubkey, new PublicKey(selectedTokenAccount.mint)));
            }
            transaction.add(createTransferInstruction(new PublicKey(selectedTokenAccount.pubkey), destinationAta, publicKey, amount));
            const sig = await sendTransaction(transaction, connection);
            await connection.confirmTransaction(sig);
            addLog(`Successfully transferred ${transferAmount} ${selectedTokenAccount.symbol}`, 'success');
            setTransferAmount('');
            setTransferDest('');
            setSelectedTokenAccount(null);
            refreshAllBalances();
        } catch (error: any) {
            addLog(`Transfer failed: ${error.message}`, 'error');
        } finally {
            setIsLoading(false);
        }
    }, [publicKey, selectedTokenAccount, transferAmount, transferDest, connection, sendTransaction, addLog, refreshAllBalances]);

    return (<div className="flex h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800"></div>);
}

export default function App() {
    const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
    return (<ConnectionProvider endpoint={RPC_ENDPOINT}><WalletProvider wallets={wallets} autoConnect><WalletModalProvider><ApexBotDashboard /></WalletModalProvider></WalletProvider></ConnectionProvider>);
}