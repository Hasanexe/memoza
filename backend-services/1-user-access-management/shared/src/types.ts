export type Role = 'Editor';

export interface AccessClaims {
  user_id: string;
  role: Role;
  exp: number;
}
