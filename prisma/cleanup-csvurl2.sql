UPDATE ImportConfig SET csvUrl = '' WHERE csvUrl NOT LIKE 'http%' AND csvUrl != '';
