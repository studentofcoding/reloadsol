'use client'

import { useEffect, useState } from 'react'
import JupiterTerminal from '@/components/JupiterTerminal'

export default function SwapPageClient() {
  // Fixed trading pair: SOL -> USDC
  const inputMint = 'So11111111111111111111111111111111111111112' // SOL
  const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
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
          
          console.log(`🔍 Inspecting ${rootName} for Jupiter branding and height adjustments...`);
          
          // Helper function to check if element is search-related
          const isSearchRelated = (element: Element): boolean => {
            const classList = Array.from(element.classList);
            const tagName = element.tagName.toLowerCase();
            
            // Check for search-related classes
            const hasSearchClasses = classList.some(cls => 
              cls.includes('search') || 
              cls.includes('dropdown') || 
              cls.includes('list') || 
              cls.includes('option') || 
              cls.includes('result') ||
              cls.includes('menu') ||
              cls.includes('popup') ||
              cls.includes('overlay') ||
              cls.includes('input') ||
              cls.includes('button') ||
              cls.includes('select') ||
              cls.includes('token')
            );
            
            // Check for Jupiter Terminal specific search result patterns
            const hasJupiterSearchClasses = classList.some(cls => 
              cls.includes('cursor-pointer') || 
              cls.includes('bg-interactive') ||
              cls.includes('hover:bg-interactive')
            );
            
            // Check for Jupiter Terminal search result list item pattern
            const isJupiterListItem = classList.includes('rounded') && 
              classList.includes('cursor-pointer') && 
              classList.includes('px-5') && 
              classList.includes('my-1') && 
              classList.includes('list-none') && 
              classList.includes('flex') && 
              classList.includes('w-full') && 
              classList.includes('items-center') && 
              classList.includes('bg-interactive');
            
            // Check for interactive elements that should be preserved
            const isInteractiveElement = [
              'input', 'button', 'select', 'textarea', 'a'
            ].includes(tagName);
            
            // Check for search-related attributes
            const hasSearchAttributes = element.hasAttribute('role') && 
              ['listbox', 'option', 'menu', 'menuitem', 'combobox', 'textbox', 'button'].includes(element.getAttribute('role') || '');
            
            // Check for placeholder text that indicates search functionality
            const hasSearchPlaceholder = element.hasAttribute('placeholder') && 
              (element.getAttribute('placeholder') || '').toLowerCase().includes('search');
            
            // Check for search-related parent elements
            const hasSearchParent = element.closest([
              '[role="listbox"]',
              '[role="menu"]', 
              '[class*="search"]',
              '[class*="dropdown"]',
              '[class*="list"]',
              '[class*="cursor-pointer"]',
              '[class*="bg-interactive"]',
              '[class*="input"]',
              '[class*="button"]',
              'input',
              'button',
              'select'
            ].join(', '));
            
            return hasSearchClasses || hasJupiterSearchClasses || isJupiterListItem || 
                   hasSearchAttributes || isInteractiveElement || hasSearchPlaceholder || !!hasSearchParent;
          };
          
          // 2. Remove spans with Jupiter branding text entirely (but preserve search results)
          const spans = root.querySelectorAll('span');
          console.log(`📊 Found ${spans.length} span elements in ${rootName}`);
          
          spans.forEach((span, index) => {
            const htmlSpan = span as HTMLElement;
            const text = span.textContent?.trim() || '';
            
            // Skip if this is search-related
            if (isSearchRelated(span)) {
              console.log(`🔍 Preserving search-related span: "${text.substring(0, 30)}..."`); 
              return;
            }
            
            // Enhanced Jupiter branding detection - only remove clear branding
            const isJupiterBranding = (
              text.toLowerCase().includes('powered by jupiter') ||
              text.toLowerCase().includes('jupiter terminal') ||
              (text.toLowerCase() === 'jupiter' && text.length <= 10) || // More specific Jupiter match
              text.toLowerCase().includes('jup.ag') ||
              text.toLowerCase().includes('jupiter exchange') ||
              text.toLowerCase().includes('jupiter aggregator') ||
              // Only remove generic "powered by" if it's clearly branding context
              (text.toLowerCase().includes('powered by') && 
               (text.toLowerCase().includes('jupiter') || text.toLowerCase().includes('jup') || text.length < 20))
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
          
          // 3. Remove Jupiter logo images entirely
          const jupiterImages = root.querySelectorAll('img[alt*="Jupiter"], img[src*="jupiter"]');
          console.log(`🖼️ Found ${jupiterImages.length} Jupiter images in ${rootName}`);
          jupiterImages.forEach((img, index) => {
            const htmlImg = img as HTMLElement;
            // Skip if this is search-related
            if (isSearchRelated(img)) {
              console.log(`🔍 Preserving search-related image`);
              return;
            }
            console.log(`🗑️ Removing Jupiter image: ${htmlImg.getAttribute('alt') || htmlImg.getAttribute('src')}`);
            cleanupDetails.push(`Removed Image: Jupiter logo`);
            htmlImg.remove();
            cleanupCount++;
          });
          
          // 4. Remove Jupiter links entirely
          const jupiterLinks = root.querySelectorAll('a[href*="jup.ag"]');
          console.log(`🔗 Found ${jupiterLinks.length} Jupiter links in ${rootName}`);
          jupiterLinks.forEach((link, index) => {
            const htmlLink = link as HTMLElement;
            // Skip if this is search-related
            if (isSearchRelated(link)) {
              console.log(`🔍 Preserving search-related link`);
              return;
            }
            console.log(`🗑️ Removing Jupiter link: ${htmlLink.getAttribute('href')}`);
            cleanupDetails.push(`Removed Link: jup.ag`);
            htmlLink.remove();
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
        
        console.log(`✅ Total cleanup completed: ${totalCleanup} elements processed`);
      };
      
      // Initial cleanup
      performCleanup();
      
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
    <div className="flex flex-col items-center justify-center" style={{ minHeight: '550px' }}>
      {isPageReady && (
        <JupiterTerminal
          initialInputMint={inputMint}
          initialOutputMint={outputMint}
        />
      )}
    </div>
  )
}