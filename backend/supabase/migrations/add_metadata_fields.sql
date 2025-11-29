-- Migration: Add metadata fields for filtering (law_type, year, ministry)
-- This migration adds metadata fields to both lovdata_documents and document_chunks
-- to enable filtering by law type, year, and ministry

-- Add metadata columns to lovdata_documents
alter table public.lovdata_documents
add column if not exists law_type text,
add column if not exists year integer,
add column if not exists ministry text;

-- Add metadata columns to document_chunks (inherited from parent document)
alter table public.document_chunks
add column if not exists law_type text,
add column if not exists year integer,
add column if not exists ministry text;

-- Create indexes for efficient filtering
create index if not exists idx_lovdata_documents_law_type
  on public.lovdata_documents (law_type)
  where law_type is not null;

create index if not exists idx_lovdata_documents_year
  on public.lovdata_documents (year)
  where year is not null;

create index if not exists idx_lovdata_documents_ministry
  on public.lovdata_documents (ministry)
  where ministry is not null;

create index if not exists idx_document_chunks_law_type
  on public.document_chunks (law_type)
  where law_type is not null;

create index if not exists idx_document_chunks_year
  on public.document_chunks (year)
  where year is not null;

create index if not exists idx_document_chunks_ministry
  on public.document_chunks (ministry)
  where ministry is not null;

-- Composite indexes for common filter combinations
create index if not exists idx_lovdata_documents_year_law_type
  on public.lovdata_documents (year, law_type)
  where year is not null and law_type is not null;

create index if not exists idx_document_chunks_year_law_type
  on public.document_chunks (year, law_type)
  where year is not null and law_type is not null;

-- Drop the old function first (with original signature)
drop function if exists search_document_chunks_hybrid(
  text,
  vector(1536),
  integer,
  integer,
  integer
);

-- Create new function with metadata filter support
create or replace function search_document_chunks_hybrid(
  search_query text,
  query_embedding vector(1536),
  result_limit integer default 10,
  result_offset integer default 0,
  rrf_k integer default 60,
  filter_year integer default null,
  filter_law_type text default null,
  filter_ministry text default null
)
returns table (
  id bigint,
  document_id bigint,
  chunk_index integer,
  content text,
  archive_filename text,
  member text,
  document_title text,
  document_date text,
  section_title text,
  section_number text,
  law_type text,
  year integer,
  ministry text,
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
  tokens := string_to_array(lower(trim(search_query)), ' ');
  fts_query := array_to_string(
    array(
      select token || ':*'
      from unnest(tokens) as token
      where length(token) > 0
    ),
    ' & '
  );

  if fts_query is null or fts_query = '' then
    fts_query := '';
  end if;

  -- Perform hybrid search with RRF on chunks with metadata filters
  return query
  with
  -- Full-text search results with metadata filters
  fts_results as (
    select
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.archive_filename,
      c.member,
      c.document_title,
      c.document_date,
      c.section_title,
      c.section_number,
      c.law_type,
      c.year,
      c.ministry,
      ts_rank(c.tsv_content, to_tsquery('norwegian', fts_query))::real as rank
    from public.document_chunks c
    where (fts_query = '' or c.tsv_content @@ to_tsquery('norwegian', fts_query))
      and (filter_year is null or c.year = filter_year)
      and (filter_law_type is null or c.law_type = filter_law_type)
      and (filter_ministry is null or c.ministry = filter_ministry)
    order by rank desc
    limit result_limit * 2
  ),
  -- Vector search results with metadata filters
  vector_results as (
    select
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.archive_filename,
      c.member,
      c.document_title,
      c.document_date,
      c.section_title,
      c.section_number,
      c.law_type,
      c.year,
      c.ministry,
      (1 - (c.embedding <=> query_embedding))::real as similarity
    from public.document_chunks c
    where c.embedding is not null
      and (filter_year is null or c.year = filter_year)
      and (filter_law_type is null or c.law_type = filter_law_type)
      and (filter_ministry is null or c.ministry = filter_ministry)
    order by c.embedding <=> query_embedding
    limit result_limit * 2
  ),
  -- Assign ranks
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
      coalesce(fts.document_id, vec.document_id) as document_id,
      coalesce(fts.chunk_index, vec.chunk_index) as chunk_index,
      coalesce(fts.content, vec.content) as content,
      coalesce(fts.archive_filename, vec.archive_filename) as archive_filename,
      coalesce(fts.member, vec.member) as member,
      coalesce(fts.document_title, vec.document_title) as document_title,
      coalesce(fts.document_date, vec.document_date) as document_date,
      coalesce(fts.section_title, vec.section_title) as section_title,
      coalesce(fts.section_number, vec.section_number) as section_number,
      coalesce(fts.law_type, vec.law_type) as law_type,
      coalesce(fts.year, vec.year) as year,
      coalesce(fts.ministry, vec.ministry) as ministry,
      fts.rank::real as fts_rank,
      vec.similarity::real as vector_distance,
      (coalesce(1.0 / (rrf_k + fts.fts_rank_pos), 0.0) +
       coalesce(1.0 / (rrf_k + vec.vector_rank_pos), 0.0))::real as rrf_score
    from fts_ranked fts
    full outer join vector_ranked vec on fts.id = vec.id
  )
  select
    cr.id,
    cr.document_id,
    cr.chunk_index,
    cr.content,
    cr.archive_filename,
    cr.member,
    cr.document_title,
    cr.document_date,
    cr.section_title,
    cr.section_number,
    cr.law_type,
    cr.year,
    cr.ministry,
    cr.fts_rank,
    cr.vector_distance,
    cr.rrf_score
  from combined_results cr
  order by cr.rrf_score desc, cr.fts_rank desc nulls last, cr.vector_distance desc nulls last
  limit result_limit
  offset result_offset;
end;
$$;

-- Grant execute permission
grant execute on function search_document_chunks_hybrid to service_role;

-- Comment
comment on function search_document_chunks_hybrid is 
'Hybrid search on document chunks combining FTS and vector search using RRF with metadata filtering support. 
Supports filtering by year, law_type, and ministry.';

