import { Routes } from '@angular/router';

import { LooperPage } from '@features/looper/looper-page';

export const routes: Routes = [
  // The looper is the landing page, so it is loaded eagerly.
  { path: '', component: LooperPage, title: 'Looper' },
  { path: '**', redirectTo: '' },
];
