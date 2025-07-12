'use client'

import { useEffect } from 'react'
import JupiterTerminal from '@/components/JupiterTerminal'
import { WalletProvider } from '@/components/WalletProvider'

export default function SwapPageClient() {
  // Fixed trading pair: SOL -> USDC
  const inputMint = 'So11111111111111111111111111111111111111112' // SOL
  const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
  
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

    // Wait for Jupiter Terminal to load and then clean up branding
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
      
      if (!hasJupiterContent && shadowRoots.length > 0) {
        shadowRoots.forEach(shadowRoot => {
          if (shadowRoot.querySelector('button, input, [class*="jupiter"], [class*="swap"], #portal-container, #jupiter-terminal') ||
              shadowRoot.children.length > 0 ||
              shadowRoot.innerHTML?.trim().length > 50) {
            hasJupiterContent = true;
          }
        });
      }
      
      // Also check for portal containers that might be created outside the terminal div
      const portalContainer = document.querySelector('#portal-container');
      if (portalContainer) {
        hasJupiterContent = true;
        console.log('🎯 Found portal container outside terminal div');
      }
      
      if (!hasJupiterContent) {
        console.log('⏳ Jupiter content not loaded yet, waiting...');
        return false; // Content not ready
      }

      console.log('🔍 Jupiter Terminal cleanup started - content detected!');
      
      // Enhanced cleanup function to remove Jupiter branding and fix bg-black issues
       const cleanupElementsInRoot = (root: Document | ShadowRoot | Element, rootName: string) => {
         let cleanupCount = 0;
         const cleanupDetails: string[] = [];
         
         console.log(`🔍 Inspecting ${rootName} for Jupiter branding...`);
         
         // 1. Remove spans with Jupiter branding text entirely
         const spans = root.querySelectorAll('span');
         console.log(`📊 Found ${spans.length} span elements in ${rootName}`);
         
         spans.forEach((span, index) => {
           const htmlSpan = span as HTMLElement;
           const text = span.textContent?.trim() || '';
           
           // Only target very specific Jupiter branding text
           const isJupiterBranding = (
             text.toLowerCase().includes('powered by jupiter') ||
             text.toLowerCase().includes('jupiter terminal') ||
             (text.toLowerCase().includes('jupiter') && text.length < 50) // Short Jupiter mentions
           );
           
           if (isJupiterBranding) {
             console.log(`🗑️ Removing Jupiter branding span: "${text}"`);
             cleanupDetails.push(`Removed Span: "${text}"`);
             htmlSpan.remove();
             cleanupCount++;
           } else if (text.includes('Jupiter')) {
             console.log(`⚠️ Found Jupiter text but not removing: "${text.substring(0, 50)}..."`);
           }
         });
         
         // 2. Remove Jupiter logo images entirely
         const jupiterImages = root.querySelectorAll('img[alt*="Jupiter"], img[src*="jupiter"]');
         console.log(`🖼️ Found ${jupiterImages.length} Jupiter images in ${rootName}`);
         jupiterImages.forEach((img, index) => {
           const htmlImg = img as HTMLElement;
           console.log(`🗑️ Removing Jupiter image: ${htmlImg.getAttribute('alt') || htmlImg.getAttribute('src')}`);
           cleanupDetails.push(`Removed Image: Jupiter logo`);
           htmlImg.remove();
           cleanupCount++;
         });
         
         // 3. Remove Jupiter links entirely
         const jupiterLinks = root.querySelectorAll('a[href*="jup.ag"]');
         console.log(`🔗 Found ${jupiterLinks.length} Jupiter links in ${rootName}`);
         jupiterLinks.forEach((link, index) => {
           const htmlLink = link as HTMLElement;
           console.log(`🗑️ Removing Jupiter link: ${htmlLink.getAttribute('href')}`);
           cleanupDetails.push(`Removed Link: jup.ag`);
           htmlLink.remove();
           cleanupCount++;
         });
         
         // 4. Fix bg-black and h-[550px] classes in portal-container children
         if (rootName.includes('document') || rootName.includes('portal')) {
           const portalContainer = root.querySelector ? root.querySelector('#portal-container') : 
                                  (root as Document).querySelector('#portal-container');
           
           if (portalContainer) {
             console.log(`🎯 Found portal-container, checking children for bg-black and h-[550px] classes...`);
             const childrenWithClasses = portalContainer.querySelectorAll('*');
             let bgBlackRemoved = 0;
             let heightClassRemoved = 0;
             
             childrenWithClasses.forEach((child) => {
               const htmlChild = child as HTMLElement;
               
               // Remove bg-black class
               if (htmlChild.classList.contains('bg-black')) {
                 console.log(`🎨 Removing bg-black class from:`, htmlChild.tagName, htmlChild.className);
                 htmlChild.classList.remove('bg-black');
                 bgBlackRemoved++;
                 cleanupCount++;
               }
               
               // Remove h-[550px] class
               if (htmlChild.classList.contains('h-[550px]')) {
                 console.log(`📏 Removing h-[550px] class from:`, htmlChild.tagName, htmlChild.className);
                 htmlChild.classList.remove('h-[550px]');
                 heightClassRemoved++;
                 cleanupCount++;
               }
             });
             
             if (bgBlackRemoved > 0) {
               cleanupDetails.push(`Removed bg-black from ${bgBlackRemoved} portal-container children`);
               console.log(`✅ Removed bg-black class from ${bgBlackRemoved} elements in portal-container`);
             }
             
             if (heightClassRemoved > 0) {
               cleanupDetails.push(`Removed h-[550px] from ${heightClassRemoved} portal-container children`);
               console.log(`✅ Removed h-[550px] class from ${heightClassRemoved} elements in portal-container`);
             }
             
             if (bgBlackRemoved === 0 && heightClassRemoved === 0) {
               console.log(`ℹ️ No bg-black or h-[550px] classes found in portal-container children`);
             }
           } else {
             console.log(`⚠️ portal-container not found in ${rootName}`);
           }
         }
         
         // 5. Remove h-[550px] class from all shadow DOM elements
         const elementsWithHeight = root.querySelectorAll('.h-\\[550px\\]');
         console.log(`📏 Found ${elementsWithHeight.length} elements with h-[550px] class in ${rootName}`);
         elementsWithHeight.forEach((element) => {
           const htmlElement = element as HTMLElement;
           console.log(`📏 Removing h-[550px] class from:`, htmlElement.tagName, htmlElement.className);
           htmlElement.classList.remove('h-[550px]');
           cleanupDetails.push(`Removed h-[550px] class from ${htmlElement.tagName}`);
           cleanupCount++;
         });
         
         // Log what we found and cleaned
         console.log(`🧹 Cleanup summary for ${rootName}: ${cleanupCount} elements processed`);
         if (cleanupDetails.length > 0) {
           console.log(`📋 Details:`, cleanupDetails);
         }
         
         return cleanupCount;
       };
       
       // Clean up portal container first
       let totalCleanup = cleanupElementsInRoot(document, 'document (portal container)');
       
       // Specifically target jupiter-terminal shadow DOM
       const jupiterTerminalElement = terminalDiv.querySelector('#jupiter-terminal') || 
                                    document.querySelector('#jupiter-terminal');
       
       if (jupiterTerminalElement && jupiterTerminalElement.shadowRoot) {
         console.log('🎯 Found jupiter-terminal shadow root!');
         totalCleanup += cleanupElementsInRoot(jupiterTerminalElement.shadowRoot, 'jupiter-terminal shadow DOM');
       } else {
         console.log('⚠️ jupiter-terminal shadow root not found, checking all shadow roots...');
         // Fallback: Clean up all detected shadow DOMs
         shadowRoots.forEach((shadowRoot, index) => {
           const shadowName = `shadow DOM ${index + 1}`;
           totalCleanup += cleanupElementsInRoot(shadowRoot, shadowName);
         });
       }
       
       // Also clean up regular DOM in terminal div
       totalCleanup += cleanupElementsInRoot(terminalDiv, 'terminal div regular DOM');
       
       console.log(`🧹 Total elements cleaned: ${totalCleanup}`);
      
      console.log('✅ Jupiter Terminal cleanup completed');
      return true; // Cleanup successful
    };

    // Polling function to repeatedly check for Jupiter content
    const pollForJupiterContent = () => {
      let attempts = 0;
      const maxAttempts = 20; // Try for up to 20 seconds
      
      const poll = () => {
        attempts++;
        console.log(`🔄 Polling attempt ${attempts}/${maxAttempts} for Jupiter content...`);
        
        const success = waitForJupiterAndCleanup();
        
        if (success) {
          console.log('🎉 Jupiter cleanup successful!');
          return; // Stop polling
        }
        
        if (attempts < maxAttempts) {
          setTimeout(poll, 1000); // Try again in 1 second
        } else {
          console.log('⚠️ Max polling attempts reached, Jupiter content may not have loaded');
        }
      };
      
      poll();
    };
    
    // Wait a bit for Jupiter Terminal to initialize, then start cleanup
    const initTimer = setTimeout(() => {
      console.log('🚀 Starting Jupiter Terminal cleanup process...');
      pollForJupiterContent();
      
      // Set up observer to catch dynamically added content
      const terminalDiv = document.getElementById('jupiter-terminal-swap');
      if (terminalDiv) {
        const observer = new MutationObserver(() => {
          console.log('🔄 DOM mutation detected, running cleanup...');
          try {
            waitForJupiterAndCleanup();
          } catch (error) {
            console.error('❌ Error during mutation cleanup:', error);
          }
        });
        
        observer.observe(terminalDiv, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          characterData: true,
          characterDataOldValue: true
        });
        
        // Cleanup observer on unmount
        return () => observer.disconnect();
      }
    }, 2000); // Wait 2 seconds for Jupiter Terminal to initialize
    
    // Cleanup timer on unmount
    return () => clearTimeout(initTimer);
  }, []);
  
  return (
    <div className="flex flex-col items-center justify-center max-h-[400px] sm:max-h-[550px]">
      <WalletProvider>
        <JupiterTerminal 
          initialInputMint={inputMint}
          initialOutputMint={outputMint}
        />
      </WalletProvider>
    </div>
  )
}