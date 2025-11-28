-- Migration: Fix type mismatch in search_document_chunks_hybrid function
-- Issue: Function returns double precision but signature expects real
-- Fix: Add explicit casts to real for all numeric return values
-- Date: 2025-11-28

create or replace function search_document_chunks_hybrid(
  search_query text,
  query_embedding vector(1536),
  result_limit integer default 10,
  result_offset integer default 0,
  rrf_k integer default 60
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

  -- Build FTS query with prefix matching
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

  -- Perform hybrid search with RRF on chunks
  return query
  with
  -- Full-text search results
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
      ts_rank(c.tsv_content, to_tsquery('norwegian', fts_query))::real as rank
    from public.document_chunks c
    where fts_query != '' and c.tsv_content @@ to_tsquery('norwegian', fts_query)
    order by rank desc
    limit result_limit * 2
  ),
  -- Vector search results
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
      (1 - (c.embedding <=> query_embedding))::real as similarity
    from public.document_chunks c
    where c.embedding is not null
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
'Hybrid search on document chunks combining FTS and vector search using RRF. 
Returns chunk-level results with preserved metadata.
Fixed: Added explicit casts to real for all numeric return values to match function signature.';

