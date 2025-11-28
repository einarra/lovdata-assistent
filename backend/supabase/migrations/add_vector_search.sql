-- Migration: Add vector search support with pgvector
-- This migration adds:
-- 1. pgvector extension
-- 2. embedding column to lovdata_documents
-- 3. Vector index for similarity search
-- 4. Hybrid search function with Reciprocal Rank Fusion (RRF)

-- Enable pgvector extension
create extension if not exists vector;

-- Add embedding column to lovdata_documents
-- Using vector(1536) for OpenAI text-embedding-3-small (1536 dimensions)
alter table public.lovdata_documents
add column if not exists embedding vector(1536);

-- Create index for vector similarity search using HNSW (Hierarchical Navigable Small World)
-- HNSW is faster for similarity search than IVFFlat, especially for large datasets
create index if not exists idx_lovdata_documents_embedding_hnsw
on public.lovdata_documents
using hnsw (embedding vector_cosine_ops);

-- Create a function for hybrid search using Reciprocal Rank Fusion (RRF)
-- RRF combines results from both full-text search (FTS) and vector search
-- Formula: RRF score = sum(1 / (k + rank)) for each result set
-- where k is a constant (typically 60) and rank is the position in the result set
create or replace function search_lovdata_documents_hybrid(
  search_query text,
  query_embedding vector(1536),
  result_limit integer default 10,
  result_offset integer default 0,
  rrf_k integer default 60
)
returns table (
  id bigint,
  archive_filename text,
  member text,
  title text,
  document_date text,
  content text,
  fts_rank real,
  vector_distance real,
  rrf_score real
)
language plpgsql
as $$
declare
  fts_query text;
  tokens text[];
begin
  -- Extract tokens from search query for FTS
  -- Convert to tsquery format with prefix matching
  tokens := string_to_array(lower(trim(search_query)), ' ');
  fts_query := array_to_string(
    array(
      select token || ':*'
      from unnest(tokens) as token
      where length(token) > 0
    ),
    ' & '
  );

  -- If no valid tokens, use empty query
  if fts_query is null or fts_query = '' then
    fts_query := '';
  end if;

  -- Perform hybrid search with RRF
  return query
  with
  -- Full-text search results with ranking
  fts_results as (
    select
      d.id,
      d.archive_filename,
      d.member,
      d.title,
      d.document_date,
      d.content,
      ts_rank(d.tsv_content, to_tsquery('norwegian', fts_query)) as rank
    from public.lovdata_documents d
    where fts_query != '' and d.tsv_content @@ to_tsquery('norwegian', fts_query)
    order by rank desc
    limit result_limit * 2  -- Get more results for better RRF fusion
  ),
  -- Vector search results with cosine similarity
  vector_results as (
    select
      d.id,
      d.archive_filename,
      d.member,
      d.title,
      d.document_date,
      d.content,
      1 - (d.embedding <=> query_embedding) as similarity  -- Cosine similarity (higher = more similar)
    from public.lovdata_documents d
    where d.embedding is not null
    order by d.embedding <=> query_embedding  -- Order by cosine distance (ascending = more similar)
    limit result_limit * 2  -- Get more results for better RRF fusion
  ),
  -- Assign ranks to each result set (1-indexed for RRF)
  fts_ranked as (
    select
      *,
      row_number() over (order by rank desc nulls last) as fts_rank_pos
    from fts_results
  ),
  vector_ranked as (
    select
      *,
      row_number() over (order by similarity desc nulls last) as vector_rank_pos
    from vector_results
  ),
  -- Combine and calculate RRF scores
  combined_results as (
    select
      coalesce(fts.id, vec.id) as id,
      coalesce(fts.archive_filename, vec.archive_filename) as archive_filename,
      coalesce(fts.member, vec.member) as member,
      coalesce(fts.title, vec.title) as title,
      coalesce(fts.document_date, vec.document_date) as document_date,
      coalesce(fts.content, vec.content) as content,
      fts.rank as fts_rank,
      vec.similarity as vector_distance,  -- Store similarity as vector_distance for compatibility
      -- Calculate RRF score: sum of 1/(k + rank) for each result set
      coalesce(1.0 / (rrf_k + fts.fts_rank_pos), 0.0) +
      coalesce(1.0 / (rrf_k + vec.vector_rank_pos), 0.0) as rrf_score
    from fts_ranked fts
    full outer join vector_ranked vec on fts.id = vec.id
  )
  select
    cr.id,
    cr.archive_filename,
    cr.member,
    cr.title,
    cr.document_date,
    cr.content,
    cr.fts_rank,
    cr.vector_distance,
    cr.rrf_score
  from combined_results cr
  order by cr.rrf_score desc, cr.fts_rank desc nulls last, cr.vector_distance desc nulls last
  limit result_limit
  offset result_offset;
end;
$$;

-- Grant execute permission to service role
grant execute on function search_lovdata_documents_hybrid to service_role;

-- Add comment explaining the function
comment on function search_lovdata_documents_hybrid is 
'Hybrid search combining full-text search (FTS) and vector similarity search using Reciprocal Rank Fusion (RRF). 
Returns results ranked by combined RRF score, which merges rankings from both search methods.';

