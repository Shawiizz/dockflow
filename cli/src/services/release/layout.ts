/**
 * Layout of a release directory on the remote manager: the file names, the link and the prefixes
 * of the temporary directories, and the shape of the metadata stored with each release.
 */

import { RELEASE_STACK_FILE } from '../../constants';

export const COMPOSE_FILE = 'docker-compose.yml';
export const METADATA_FILE = 'metadata.json';
export const RELEASE_FILES = [COMPOSE_FILE, RELEASE_STACK_FILE, METADATA_FILE];
export const CURRENT_LINK = 'current';
/** a release being written, renamed into place once complete */
export const TEMP_PREFIX = '.tmp-';
/** the previous files of a version being redeployed, put back if that redeploy fails */
export const BACKUP_PREFIX = '.previous-';

export interface ReleaseMetadata {
  project_name: string;
  version: string;
  env: string;
  timestamp: string;
  epoch: number;
  performer: string;
  branch: string;
  /** digest of the accessories compose running when the release was made; absent from older releases and when there are no accessories */
  accessories_digest?: string;
}
