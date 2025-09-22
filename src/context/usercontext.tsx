"use client"
import { createContext, useState } from 'react'

interface LoadingState {
    tokenList: boolean;
    balance: boolean;
    swap: boolean;
    transfer: boolean;
}

interface UserContextType {
    tokenList: any[];
    setTokenList: (value: any[]) => void;
    loadingState: LoadingState;
    setLoadingState: (value: LoadingState) => void;
    updateLoadingState: (key: keyof LoadingState, value: boolean) => void;
    swapState: boolean;
    setSwapState: (value: boolean) => void;
    tokenFilterList: any[];
    setTokenFilterList: (value: any[]) => void;
    selectedTokenList: any[];
    setSelectedTokenList: (value: any[]) => void;
    currentAmount: number;
    setCurrentAmount: (value: number) => void;
    swapTokenList: any[];
    setSwapTokenList: (value: any[]) => void;
    textLoadingState: boolean;
    setTextLoadingState: (value: boolean) => void;
    loadingText: string;
    setLoadingText: (value: string) => void;
    tokeBalance: number;
    setTokeBalance: (value: number) => void;
}

export function UserContextProvider({ children }: { children: React.ReactNode }) {
    const [tokenList, setTokenList] = useState<any[]>([]);
    const [tokenFilterList, setTokenFilterList] = useState<any[]>([]);
    const [selectedTokenList, setSelectedTokenList] = useState<any[]>([]);
    const [currentAmount, setCurrentAmount] = useState(0);
    const [swapTokenList, setSwapTokenList] = useState<any[]>([]);
    const [textLoadingState, setTextLoadingState] = useState(false);
    const [loadingText, setLoadingText] = useState("");
    const [tokeBalance, setTokeBalance] = useState(0);
    const [swapState, setSwapState] = useState(false);
    const [loadingState, setLoadingState] = useState<LoadingState>({
        tokenList: false,
        balance: false,
        swap: false,
        transfer: false
    });

    const updateLoadingState = (key: keyof LoadingState, value: boolean) => {
        setLoadingState(prev => ({ ...prev, [key]: value }));
    };

    return (
        <UserContext.Provider
      value= {{
        tokenList,
            setTokenList,
            tokenFilterList,
            setTokenFilterList,
            selectedTokenList,
            setSelectedTokenList,
            currentAmount,
            setCurrentAmount,
            loadingState,
            setLoadingState,
            updateLoadingState,
            swapTokenList,
            setSwapTokenList,
            textLoadingState,
            setTextLoadingState,
            loadingText,
            setLoadingText,
            tokeBalance,
            setTokeBalance,
            swapState,
            setSwapState,
      }
}
    >
    { children }
    </UserContext.Provider>
  );
}

const UserContext = createContext<UserContextType>({} as UserContextType);
export default UserContext;