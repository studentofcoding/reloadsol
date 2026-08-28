'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Script from 'next/script'
import JupiterTerminal from '@/components/JupiterTerminal'
import { TOKENS } from '@/utils/solana'

type SwapPreset = {
  key: string
  label: string
  inputMint: string
  outputMint: string
}

export default function SolSwapClient() {
  const searchParams = useSearchParams()
  const requestedTokenMint = searchParams.get('tokenMint')?.trim() ?? ''
  const requestedFromMint = searchParams.get('fromMint')?.trim() ?? ''
  const requestedToMint = searchParams.get('toMint')?.trim() ?? ''
  const tokenMint =
    requestedTokenMint &&
    requestedTokenMint !== TOKENS.SOL &&
    requestedTokenMint !== TOKENS.USDC
      ? requestedTokenMint
      : null
  const fromMint =
    requestedFromMint &&
    requestedFromMint !== TOKENS.SOL &&
    requestedFromMint !== TOKENS.USDC
      ? requestedFromMint
      : null
  const toMint =
    requestedToMint &&
    requestedToMint !== TOKENS.SOL &&
    requestedToMint !== TOKENS.USDC
      ? requestedToMint
      : null

  const swapPresets = useMemo<SwapPreset[]>(() => {
    // True any-to-any: both sides are non-quote SPL mints.
    if (fromMint && toMint) {
      return [
        {
          key: 'token-to-token',
          label: 'Token -> Token',
          inputMint: fromMint,
          outputMint: toMint,
        },
      ]
    }
    if (tokenMint) {
      return [
        {
          key: 'sol-to-token',
          label: 'SOL -> Token',
          inputMint: TOKENS.SOL,
          outputMint: tokenMint,
        },
        {
          key: 'usdc-to-token',
          label: 'USDC -> Token',
          inputMint: TOKENS.USDC,
          outputMint: tokenMint,
        },
        {
          key: 'token-to-sol',
          label: 'Token -> SOL',
          inputMint: tokenMint,
          outputMint: TOKENS.SOL,
        },
        {
          key: 'token-to-usdc',
          label: 'Token -> USDC',
          inputMint: tokenMint,
          outputMint: TOKENS.USDC,
        },
      ]
    }
    return [
      {
        key: 'sol-to-usdc',
        label: 'SOL -> USDC',
        inputMint: TOKENS.SOL,
        outputMint: TOKENS.USDC,
      },
      {
        key: 'usdc-to-sol',
        label: 'USDC -> SOL',
        inputMint: TOKENS.USDC,
        outputMint: TOKENS.SOL,
      },
    ]
  }, [tokenMint, fromMint, toMint])
  const [selectedPresetKey, setSelectedPresetKey] = useState<string | null>(null)
  const activePreset =
    swapPresets.find((preset) => preset.key === selectedPresetKey) ??
    swapPresets[0]
  const [isPageReady, setIsPageReady] = useState(false)

  // Ensure page is ready before rendering Jupiter Terminal
  useEffect(() => {
    // Small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      setIsPageReady(true)
    }, 100)

    return () => clearTimeout(timer)
  }, [])

  // Jupiter Terminal cleanup logic - runs after terminal initialization
  useEffect(() => {
    // Enhanced function to find all shadow roots recursively
    const getAllShadowRoots = (element: Element): ShadowRoot[] => {
      const shadowRoots: ShadowRoot[] = [];

      // Check current element
      if (element.shadowRoot) {
        shadowRoots.push(element.shadowRoot);
        // Recursively check shadow root children
        element.shadowRoot.querySelectorAll('*').forEach(child => {
          shadowRoots.push(...getAllShadowRoots(child));
        });
      }

      // Check all child elements
      element.querySelectorAll('*').forEach(child => {
        shadowRoots.push(...getAllShadowRoots(child));
      });

      return shadowRoots;
    };

    const waitForJupiterAndCleanup = () => {
      const terminalDiv = document.getElementById('jupiter-terminal-swap');
      if (!terminalDiv) {
        console.log('❌ Jupiter terminal div not found');
        return false;
      }

      // Check if Jupiter content has loaded (including shadow DOM and portal containers)
      let hasJupiterContent = false;

      // Check regular DOM first
      const regularContent = terminalDiv.querySelector('button, input, [class*="jupiter"], [class*="swap"], #portal-container, #jupiter-terminal') ||
                            terminalDiv.children.length > 0 ||
                            terminalDiv.innerHTML.trim().length > 100;

      if (regularContent) {
        hasJupiterContent = true;
      }

      // Check shadow DOM for content
      const shadowRoots = getAllShadowRoots(terminalDiv);
      console.log(`🔍 Found ${shadowRoots.length} shadow roots`);

      shadowRoots.forEach((shadowRoot, index) => {
        const shadowContent = shadowRoot.children.length > 0 || shadowRoot.innerHTML.trim().length > 50;
        if (shadowContent) {
          console.log(`✅ Shadow root ${index + 1} has content`);
          hasJupiterContent = true;
        }
      });

      // Check portal container in document
      const portalContainer = document.querySelector('#portal-container');
      if (portalContainer && portalContainer.children.length > 0) {
        console.log('✅ Portal container has content');
        hasJupiterContent = true;
      }

      if (!hasJupiterContent) {
        console.log('⏳ Jupiter content not loaded yet...');
        return false;
      }

      console.log('🎯 Jupiter content detected! Starting cleanup...');

      // Debounced mutation observer to avoid cleanup during search interactions
      let cleanupTimeout: NodeJS.Timeout;
      const debouncedCleanup = () => {
        clearTimeout(cleanupTimeout);
        cleanupTimeout = setTimeout(() => {
          performCleanup();
        }, 500); // Wait 500ms after last mutation
      };

      // Set up mutation observer to detect search-related changes
      const observer = new MutationObserver((mutations) => {
        const isSearchRelatedMutation = mutations.some(mutation => {
          const target = mutation.target as Element;
          return target.closest && (
            target.closest('[class*="search"]') ||
            target.closest('[class*="dropdown"]') ||
            target.closest('[class*="list"]') ||
            target.closest('[role="listbox"]') ||
            target.closest('[role="menu"]') ||
            target.closest('[class*="cursor-pointer"]') ||
            target.closest('[class*="bg-interactive"]')
          );
        });

        if (!isSearchRelatedMutation) {
          debouncedCleanup();
        }
      });

      // Start observing
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });

      const performCleanup = () => {
        const cleanupElementsInRoot = (root: Document | ShadowRoot | Element, rootName: string) => {
          let cleanupCount = 0;
          const cleanupDetails: string[] = [];

          // Find all elements that might be in the way
          const candidates = root.querySelectorAll('*');
          candidates.forEach(el => {
            const elClass = (el.className?.toString?.() || '').toLowerCase();
            const elText = (el.textContent || '').toLowerCase();

            // Skip our own swap page content
            if (el.id === 'jupiter-terminal-swap' || el.closest('#jupiter-terminal-swap')) return;
            if (el.closest('nav') || el.closest('header') || el.closest('main')) return;

            // Look for Jupiter's own modal/dropdown overlays that escaped
            if (elClass.includes('jupiter') && (
                elClass.includes('modal') ||
                elClass.includes('dropdown') ||
                elClass.includes('overlay') ||
                elClass.includes('popup')
              )) {
              (el as HTMLElement).style.display = 'none';
              cleanupCount++;
              cleanupDetails.push(`Hidden Jupiter ${el.tagName} (${elClass.slice(0, 30)})`);
            }
          });
          return { cleanupCount, cleanupDetails };
        };

        let total = 0;
        const allDetails: string[] = [];
        const mainRoot = cleanupElementsInRoot(document, 'document');
        total += mainRoot.cleanupCount;
        allDetails.push(...mainRoot.cleanupDetails);

        const shadowRoots = getAllShadowRoots(document.documentElement);
        shadowRoots.forEach((shadowRoot, index) => {
          const shadowResult = cleanupElementsInRoot(shadowRoot, `shadow-${index}`);
          total += shadowResult.cleanupCount;
          allDetails.push(...shadowResult.cleanupDetails);
        });

        if (total > 0) {
          console.log(`🧹 Jupiter cleanup: ${total} elements hidden`);
        }
      };

      return true;
    };

    const pollForJupiterContent = () => {
      let attempts = 0;
      const maxAttempts = 20; // Try for up to 20 seconds

      const poll = () => {
        attempts++;
        console.log(`🔄 Polling attempt ${attempts}/${maxAttempts} for Jupiter content...`);

        if (waitForJupiterAndCleanup()) {
          console.log('✅ Jupiter cleanup completed successfully!');
          return;
        }

        if (attempts < maxAttempts) {
          setTimeout(poll, 1000); // Check every second
        } else {
          console.log('⏰ Max polling attempts reached. Jupiter content may not have loaded.');
        }
      };

      // Start polling after a short delay to ensure DOM is ready
      setTimeout(poll, 3000); // Increased delay to allow skeleton to show first
    };

    // Start the polling process
    pollForJupiterContent();
  }, [isPageReady]);

  return (
    <div
      className="flex flex-col items-center justify-center gap-4"
      style={{ minHeight: '550px' }}
    >
      <div className="flex w-full max-w-2xl flex-wrap justify-center gap-2">
        {swapPresets.map((preset) => {
          const isActive = preset.key === activePreset.key

          return (
            <button
              key={preset.key}
              type="button"
              onClick={() => setSelectedPresetKey(preset.key)}
              className={`rounded-full border px-4 py-2 text-sm transition ${
                isActive
                  ? 'border-white bg-white text-black'
                  : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500 hover:text-white'
              }`}
            >
              {preset.label}
            </button>
          )
        })}
      </div>
      <Script
        src="https://plugin.jup.ag/plugin-v1.js"
        strategy="afterInteractive"
        data-preload
      />
      {isPageReady && (
        <JupiterTerminal
          key={`${activePreset.inputMint}-${activePreset.outputMint}`}
          initialInputMint={activePreset.inputMint}
          initialOutputMint={activePreset.outputMint}
        />
      )}
    </div>
  )
}
