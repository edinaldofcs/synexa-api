import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private _adminClient: SupabaseClient<any, 'public', any>;

  constructor() {
    this._adminClient = createClient<any, 'public', any>(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );
  }

  get admin() {
    return this._adminClient;
  }
}
