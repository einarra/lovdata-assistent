/**
 * Document chunking service for splitting legal documents into smaller, searchable chunks.
 * 
 * This service:
 * - Splits documents into chunks of configurable size (default: 12,800 characters)
 * - Adds overlap between chunks to preserve context
 * - Extracts and preserves metadata (section titles, numbers)
 * - Maintains document structure information
 */

export interface ChunkMetadata {
  sectionTitle?: string | null;
  sectionNumber?: string | null;
}

export interface DocumentChunk {
  chunkIndex: number;
  content: string;
  contentLength: number;
  startChar: number;
  endChar: number;
  metadata: ChunkMetadata;
}

export interface ChunkingOptions {
  chunkSize?: number; // Target chunk size in characters (default: 12800)
  overlapSize?: number; // Overlap between chunks in characters (default: 20% of chunkSize)
  preserveParagraphs?: boolean; // Try to split at paragraph boundaries (default: true)
  extractSections?: boolean; // Extract section metadata (default: true)
}

export class DocumentChunker {
  private readonly chunkSize: number;
  private readonly overlapSize: number;
  private readonly preserveParagraphs: boolean;
  private readonly extractSections: boolean;

  constructor(options: ChunkingOptions = {}) {
    this.chunkSize = options.chunkSize ?? 12800;
    this.overlapSize = options.overlapSize ?? Math.floor(this.chunkSize * 0.2); // 20% overlap
    this.preserveParagraphs = options.preserveParagraphs ?? true;
    this.extractSections = options.extractSections ?? true;
  }

  /**
   * Split a document into chunks with overlap and metadata preservation.
   */
  chunkDocument(content: string): DocumentChunk[] {
    if (!content || content.length === 0) {
      return [];
    }

    // If document is smaller than chunk size, return as single chunk
    if (content.length <= this.chunkSize) {
      return [{
        chunkIndex: 0,
        content,
        contentLength: content.length,
        startChar: 0,
        endChar: content.length,
        metadata: this.extractSections ? this.extractSectionMetadata(content, 0) : {}
      }];
    }

    const chunks: DocumentChunk[] = [];
    let currentPos = 0;
    let chunkIndex = 0;

    while (currentPos < content.length) {
      const remaining = content.length - currentPos;
      
      // Determine chunk end position
      let chunkEnd = currentPos + this.chunkSize;
      
      // If this is not the last chunk and we have remaining content
      if (chunkEnd < content.length) {
        // Try to split at a paragraph boundary if preserveParagraphs is enabled
        if (this.preserveParagraphs) {
          const paragraphBoundary = this.findParagraphBoundary(content, chunkEnd, this.chunkSize * 0.1);
          if (paragraphBoundary > currentPos) {
            chunkEnd = paragraphBoundary;
          }
        }
        
        // Ensure we don't exceed content length
        chunkEnd = Math.min(chunkEnd, content.length);
      } else {
        // Last chunk - include all remaining content
        chunkEnd = content.length;
      }

      // Extract chunk content
      const chunkContent = content.substring(currentPos, chunkEnd);
      
      // Extract metadata for this chunk
      const metadata = this.extractSections 
        ? this.extractSectionMetadata(chunkContent, currentPos)
        : {};

      chunks.push({
        chunkIndex,
        content: chunkContent,
        contentLength: chunkContent.length,
        startChar: currentPos,
        endChar: chunkEnd,
        metadata
      });

      // Move to next chunk position (with overlap)
      if (chunkEnd >= content.length) {
        break; // Reached end of document
      }

      // Calculate next start position with overlap
      currentPos = chunkEnd - this.overlapSize;
      // Ensure we don't go backwards
      if (currentPos <= chunks[chunks.length - 1].startChar) {
        currentPos = chunks[chunks.length - 1].endChar;
      }
      
      chunkIndex++;
    }

    return chunks;
  }

  /**
   * Find a paragraph boundary near the target position.
   * Searches within a window around the target position.
   */
  private findParagraphBoundary(content: string, targetPos: number, searchWindow: number): number {
    // Look for paragraph breaks (double newlines) near the target position
    const searchStart = Math.max(0, targetPos - searchWindow);
    const searchEnd = Math.min(content.length, targetPos + searchWindow);

    // First, try to find a paragraph break after the target
    const afterMatch = content.indexOf('\n\n', targetPos);
    if (afterMatch !== -1 && afterMatch < searchEnd) {
      return afterMatch + 2; // Include the newlines
    }

    // Then, try to find a paragraph break before the target
    const beforeMatch = content.lastIndexOf('\n\n', targetPos);
    if (beforeMatch !== -1 && beforeMatch > searchStart) {
      return beforeMatch + 2; // Include the newlines
    }

    // If no paragraph break found, try single newline
    const singleNewlineAfter = content.indexOf('\n', targetPos);
    if (singleNewlineAfter !== -1 && singleNewlineAfter < searchEnd) {
      return singleNewlineAfter + 1;
    }

    const singleNewlineBefore = content.lastIndexOf('\n', targetPos);
    if (singleNewlineBefore !== -1 && singleNewlineBefore > searchStart) {
      return singleNewlineBefore + 1;
    }

    // No good boundary found, return target position
    return targetPos;
  }

  /**
   * Extract section metadata from chunk content.
   * Looks for section titles, numbers, and headings in Norwegian legal documents.
   */
  private extractSectionMetadata(content: string, position: number): ChunkMetadata {
    const metadata: ChunkMetadata = {};

    // Look for section patterns in the first part of the chunk
    // Check first 2000 characters for section headers
    const headerRegion = content.substring(0, Math.min(2000, content.length));

    // Pattern 1: Section numbers like "§ 1", "§1", "Paragraf 1"
    const sectionNumberPatterns = [
      /§\s*(\d+[a-z]?)/i,
      /paragraf\s+(\d+[a-z]?)/i,
      /kapittel\s+(\d+[a-z]?)/i,
      /<paragraf[^>]*>([^<]+)/i,
      /<kapittel[^>]*>([^<]+)/i
    ];

    for (const pattern of sectionNumberPatterns) {
      const match = headerRegion.match(pattern);
      if (match && match[1]) {
        metadata.sectionNumber = match[1].trim();
        break;
      }
    }

    // Pattern 2: Section titles/headings
    const sectionTitlePatterns = [
      /<overskrift[^>]*>([^<]{1,200})/i,
      /<tittel[^>]*>([^<]{1,200})/i,
      /<heading[^>]*>([^<]{1,200})/i,
      /^#+\s+(.+)$/m, // Markdown-style headings
      /^(.+)\n={3,}$/m // Underlined headings
    ];

    for (const pattern of sectionTitlePatterns) {
      const match = headerRegion.match(pattern);
      if (match && match[1]) {
        const title = this.decodeXmlEntities(match[1].trim());
        if (title.length > 0 && title.length < 200) {
          metadata.sectionTitle = title;
          break;
        }
      }
    }

    return metadata;
  }

  /**
   * Decode XML entities in text.
   */
  private decodeXmlEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  /**
   * Get the default chunk size.
   */
  getChunkSize(): number {
    return this.chunkSize;
  }

  /**
   * Get the overlap size.
   */
  getOverlapSize(): number {
    return this.overlapSize;
  }
}

