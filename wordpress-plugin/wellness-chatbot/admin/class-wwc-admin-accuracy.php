<?php
/**
 * Recommendation Accuracy screen.
 *
 * Everything that decides whether a customer asking for "a shampoo for dry
 * scalp" gets shampoos: resyncing the six source fields, mapping the store's
 * WooCommerce categories to shelves, reviewing product types, and testing a
 * real customer question against the live catalogue.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_Accuracy {

	const PAGE        = 'wellness-chatbot-accuracy';
	const RESYNC_SIZE = 50;

	public static function init() {
		add_action( 'admin_post_wwc_save_categories', array( __CLASS__, 'handle_save_categories' ) );
		add_action( 'admin_post_wwc_suggest_categories', array( __CLASS__, 'handle_suggest_categories' ) );
		add_action( 'admin_post_wwc_set_product_type', array( __CLASS__, 'handle_set_product_type' ) );
		add_action( 'wp_ajax_wwc_resync_chunk', array( __CLASS__, 'ajax_resync_chunk' ) );
		add_action( 'wp_ajax_wwc_test_question', array( __CLASS__, 'ajax_test_question' ) );
	}

	public static function render() {
		WWC_Admin::page( __( 'Recommendation Accuracy', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	/**
	 * Shelf choices for a category.
	 *
	 * @return array<string,string>
	 */
	private static function shelves() {
		return array(
			'face'     => __( 'Face care', 'wellness-chatbot' ),
			'hair'     => __( 'Hair & scalp', 'wellness-chatbot' ),
			'body'     => __( 'Body care', 'wellness-chatbot' ),
			'vitamins' => __( 'Vitamins & supplements', 'wellness-chatbot' ),
			'general'  => __( 'Other products (makeup, baby, oral care, first aid…)', 'wellness-chatbot' ),
			'medicine' => __( 'Medicine — never recommended', 'wellness-chatbot' ),
			'none'     => __( 'Says nothing about the product (a brand, offers, new arrivals)', 'wellness-chatbot' ),
		);
	}

	/**
	 * The backend's product-type vocabulary, fetched once per request.
	 *
	 * @return array<int,array{key:string,label:string,shelf:string}>
	 */
	private static function product_types() {
		static $types = null;
		if ( null !== $types ) {
			return $types;
		}
		$types    = array();
		$response = WWC_Backend_Client::get( '/api/admin/product-types' );
		if ( ! is_wp_error( $response ) && isset( $response['types'] ) && is_array( $response['types'] ) ) {
			$types = $response['types'];
		}
		return $types;
	}

	/**
	 * A product-type dropdown grouped by shelf.
	 *
	 * @param string $name        Field name.
	 * @param string $selected    Selected key.
	 * @param string $empty_label Label for the empty option, or '' for none.
	 * @return string
	 */
	private static function type_select( $name, $selected, $empty_label = '' ) {
		$groups = array();
		foreach ( self::product_types() as $type ) {
			$groups[ $type['shelf'] ][] = $type;
		}
		$shelves = self::shelves();
		$html    = sprintf( '<select name="%s">', esc_attr( $name ) );
		if ( '' !== $empty_label ) {
			$html .= sprintf( '<option value="">%s</option>', esc_html( $empty_label ) );
		}
		foreach ( $groups as $shelf => $types ) {
			$html .= sprintf( '<optgroup label="%s">', esc_attr( isset( $shelves[ $shelf ] ) ? $shelves[ $shelf ] : $shelf ) );
			foreach ( $types as $type ) {
				$html .= sprintf(
					'<option value="%s"%s>%s</option>',
					esc_attr( $type['key'] ),
					selected( $selected, $type['key'], false ),
					esc_html( $type['label'] )
				);
			}
			$html .= '</optgroup>';
		}
		return $html . '</select>';
	}

	public static function body() {
		WWC_Admin::render_notice_from_query();

		if ( ! WWC_Settings::is_connected() ) {
			return;
		}

		$summary = WWC_Backend_Client::get( '/api/admin/accuracy/summary' );
		if ( is_wp_error( $summary ) ) {
			WWC_Admin::error_notice( $summary );
			return;
		}

		self::render_overview( $summary );
		self::render_resync();
		self::render_categories();
		self::render_products( $summary );
		self::render_test();
	}

	private static function render_overview( array $summary ) {
		$with_issues = isset( $summary['with_issues'] ) ? (int) $summary['with_issues'] : 0;
		$untyped     = isset( $summary['untyped_labeled'] ) ? (int) $summary['untyped_labeled'] : 0;
		$confirmed   = isset( $summary['categories_confirmed'] ) ? (int) $summary['categories_confirmed'] : 0;
		$cat_total   = isset( $summary['categories_total'] ) ? (int) $summary['categories_total'] : 0;
		$typed       = isset( $summary['by_type'] ) && is_array( $summary['by_type'] ) ? array_sum( $summary['by_type'] ) : 0;

		echo '<div class="wwc-card">';
		echo '<p>' . esc_html__( 'Every recommendation is now filtered by product type: a customer who asks for a shampoo is only ever shown shampoos. That makes each product’s type the thing to get right. Work through these steps once, in order:', 'wellness-chatbot' ) . '</p>';
		echo '<ol class="wwc-steps">';
		printf( '<li>%s</li>', esc_html__( 'Settings → Product data fields: confirm which ACF fields hold Ingredients and How to use.', 'wellness-chatbot' ) );
		printf( '<li>%s</li>', esc_html__( 'Resync every product (below), so the backend has all six fields and the category paths.', 'wellness-chatbot' ) );
		printf(
			'<li>%s <strong>%s</strong></li>',
			esc_html__( 'Map your WooCommerce categories to shelves (below).', 'wellness-chatbot' ),
			esc_html( sprintf( /* translators: 1: confirmed, 2: total */ __( '%1$d of %2$d confirmed.', 'wellness-chatbot' ), $confirmed, $cat_total ) )
		);
		printf(
			'<li>%s <a href="%s">%s</a></li>',
			esc_html__( 'Relabel the catalogue so every product gets a type: on the Label Review Queue, Reset all (tick “include human-verified”), then Label all.', 'wellness-chatbot' ),
			esc_url( admin_url( 'admin.php?page=' . WWC_Admin::MENU_SLUG ) ),
			esc_html__( 'Open the Label Review Queue', 'wellness-chatbot' )
		);
		printf( '<li>%s</li>', esc_html__( 'Fix any product flagged below, then try real customer questions in “Test a question”.', 'wellness-chatbot' ) );
		echo '</ol>';

		printf(
			'<p><strong>%s</strong></p>',
			esc_html(
				sprintf(
					/* translators: 1: typed products, 2: products needing a check, 3: labelled but untyped */
					__( '%1$d products have a type · %2$d need a type check · %3$d labelled without a type', 'wellness-chatbot' ),
					$typed,
					$with_issues,
					$untyped
				)
			)
		);
		echo '</div>';
	}

	private static function render_resync() {
		echo '<h2>' . esc_html__( 'Resync every product', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Sends every published product to the backend again, in batches of 50, with its categories, tags, description, ingredients and how to use. It does not relabel anything or spend OpenAI credit. Keep this page open until it finishes.', 'wellness-chatbot' ) . '</p>';
		printf( '<p><button type="button" class="button button-primary" id="wwc-resync-start">%s</button></p>', esc_html__( 'Resync all products', 'wellness-chatbot' ) );
		echo '<p id="wwc-resync-status" class="description" aria-live="polite"></p>';
	}

	private static function render_categories() {
		echo '<h2>' . esc_html__( 'WooCommerce categories → shelves', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Each category decides which shelf its products belong on. When every product in a category is the same kind of thing (a “Shampoos” category), also set its product type — the AI then never has to guess for those products. Categories appear here after a resync.', 'wellness-chatbot' ) . '</p>';

		$response = WWC_Backend_Client::get( '/api/admin/categories' );
		if ( is_wp_error( $response ) ) {
			WWC_Admin::error_notice( $response );
			return;
		}
		$categories = isset( $response['categories'] ) && is_array( $response['categories'] ) ? $response['categories'] : array();

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_suggest_categories' );
		echo '<input type="hidden" name="action" value="wwc_suggest_categories" />';
		printf(
			'<p><button type="submit" class="button">%s</button> <label><input type="checkbox" name="only_unconfirmed" value="1" checked="checked" /> %s</label></p>',
			esc_html__( 'Suggest with AI', 'wellness-chatbot' ),
			esc_html__( 'only categories nobody has confirmed yet', 'wellness-chatbot' )
		);
		echo '</form>';

		if ( empty( $categories ) ) {
			echo '<p><em>' . esc_html__( 'No categories yet — run “Resync all products” first.', 'wellness-chatbot' ) . '</em></p>';
			return;
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_save_categories' );
		echo '<input type="hidden" name="action" value="wwc_save_categories" />';
		echo '<table class="widefat striped wwc-category-map"><thead><tr>';
		echo '<th>' . esc_html__( 'Category', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Products', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Shelf', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Every product in it is a…', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Status', 'wellness-chatbot' ) . '</th>';
		echo '</tr></thead><tbody>';

		foreach ( $categories as $row ) {
			$id        = (int) $row['woo_category_id'];
			$shelf     = isset( $row['effective_shelf'] ) ? (string) $row['effective_shelf'] : '';
			$type      = isset( $row['effective_product_type'] ) ? (string) $row['effective_product_type'] : '';
			$confirmed = ! empty( $row['confirmed'] );

			echo '<tr>';
			printf( '<td>%s</td>', esc_html( $row['path'] ) );
			printf( '<td>%d</td>', (int) $row['product_count'] );

			printf( '<td><select name="mappings[%d][shelf]">', $id );
			printf( '<option value="">%s</option>', esc_html__( '— not mapped —', 'wellness-chatbot' ) );
			foreach ( self::shelves() as $key => $label ) {
				printf( '<option value="%s"%s>%s</option>', esc_attr( $key ), selected( $shelf, $key, false ), esc_html( $label ) );
			}
			echo '</select></td>';

			echo '<td>' . self::type_select( 'mappings[' . $id . '][type]', $type, __( 'Varies — decide per product', 'wellness-chatbot' ) ) . '</td>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- built from escaped parts.

			if ( $confirmed ) {
				printf( '<td><span class="wwc-flag wwc-flag-ok">%s</span></td>', esc_html__( 'confirmed', 'wellness-chatbot' ) );
			} elseif ( '' !== $shelf ) {
				printf( '<td><span class="wwc-flag wwc-flag-warn">%s</span></td>', esc_html__( 'AI suggestion', 'wellness-chatbot' ) );
			} else {
				printf( '<td><span class="wwc-flag wwc-flag-warn">%s</span></td>', esc_html__( 'not mapped', 'wellness-chatbot' ) );
			}
			echo '</tr>';
		}
		echo '</tbody></table>';
		printf( '<p><button type="submit" class="button button-primary">%s</button> <span class="description">%s</span></p>', esc_html__( 'Save category mapping', 'wellness-chatbot' ), esc_html__( 'Saving confirms every mapped row. Relabel afterwards for type changes to reach existing products.', 'wellness-chatbot' ) );
		echo '</form>';
	}

	private static function render_products( array $summary ) {
		$with_issues = isset( $summary['with_issues'] ) ? (int) $summary['with_issues'] : 0;

		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only filters.
		$type   = isset( $_GET['wwc_type'] ) ? sanitize_key( wp_unslash( $_GET['wwc_type'] ) ) : '';
		$search = isset( $_GET['wwc_search'] ) ? sanitize_text_field( wp_unslash( $_GET['wwc_search'] ) ) : '';
		$issues = isset( $_GET['wwc_issues'] ) ? '1' === $_GET['wwc_issues'] : ( $with_issues > 0 && '' === $type && '' === $search );
		// phpcs:enable

		echo '<h2 id="wwc-products">' . esc_html__( 'Product types', 'wellness-chatbot' ) . '</h2>';
		if ( $with_issues > 0 ) {
			printf(
				'<div class="notice notice-warning inline"><p>%s</p></div>',
				esc_html(
					sprintf(
						/* translators: %d: count */
						_n(
							'%d product has a type that contradicts its name. It is not recommended to anyone until you confirm its type here.',
							'%d products have a type that contradicts their name. They are not recommended to anyone until you confirm their type here.',
							$with_issues,
							'wellness-chatbot'
						),
						$with_issues
					)
				)
			);
		}

		echo '<form method="get" action="' . esc_url( admin_url( 'admin.php' ) ) . '" class="wwc-filter-bar">';
		printf( '<input type="hidden" name="page" value="%s" />', esc_attr( self::PAGE ) );
		printf( '<input type="search" name="wwc_search" value="%s" placeholder="%s" /> ', esc_attr( $search ), esc_attr__( 'Product name, brand or ID', 'wellness-chatbot' ) );
		echo self::type_select( 'wwc_type', $type, __( 'Any type', 'wellness-chatbot' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		printf( ' <label><input type="checkbox" name="wwc_issues" value="1"%s /> %s</label> ', checked( $issues, true, false ), esc_html__( 'Needs a type check', 'wellness-chatbot' ) );
		printf( '<button type="submit" class="button">%s</button>', esc_html__( 'Show', 'wellness-chatbot' ) );
		echo '</form>';

		$query = array( 'limit' => 100 );
		if ( $issues ) {
			$query['issues'] = '1';
		}
		if ( '' !== $type ) {
			$query['type'] = $type;
		}
		if ( '' !== $search ) {
			$query['search'] = $search;
		}
		if ( ! $issues && '' === $type && '' === $search ) {
			echo '<p class="description">' . esc_html__( 'Choose a type to review every product of that type, or search for a product.', 'wellness-chatbot' ) . '</p>';
			return;
		}

		$response = WWC_Backend_Client::get( '/api/admin/products', $query );
		if ( is_wp_error( $response ) ) {
			WWC_Admin::error_notice( $response );
			return;
		}
		$rows = isset( $response['rows'] ) && is_array( $response['rows'] ) ? $response['rows'] : array();
		printf( '<p>%s</p>', esc_html( sprintf( /* translators: %d: count */ __( '%d products match.', 'wellness-chatbot' ), (int) $response['total'] ) ) );
		if ( empty( $rows ) ) {
			return;
		}

		$back = add_query_arg(
			array(
				'page'       => self::PAGE,
				'wwc_type'   => $type,
				'wwc_search' => $search,
				'wwc_issues' => $issues ? '1' : '0',
			),
			admin_url( 'admin.php' )
		);

		echo '<table class="widefat striped"><thead><tr>';
		echo '<th>' . esc_html__( 'Product', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Categories', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Type', 'wellness-chatbot' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $rows as $row ) {
			echo '<tr>';
			printf(
				'<td><strong>%s</strong><br /><span class="description">#%d · %s</span>%s</td>',
				esc_html( $row['name'] ),
				(int) $row['product_id'],
				esc_html( isset( $row['type_source'] ) && $row['type_source'] ? sprintf( /* translators: %s: who set it */ __( 'type set by %s', 'wellness-chatbot' ), $row['type_source'] ) : __( 'no type yet', 'wellness-chatbot' ) ),
				empty( $row['label_issues'] ) ? '' : '<br /><span class="wwc-flag wwc-flag-warn">' . esc_html( implode( ' ', (array) $row['label_issues'] ) ) . '</span>'
			);
			printf( '<td>%s</td>', esc_html( implode( ', ', (array) $row['categories'] ) ) );

			echo '<td><form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			wp_nonce_field( 'wwc_set_product_type' );
			echo '<input type="hidden" name="action" value="wwc_set_product_type" />';
			printf( '<input type="hidden" name="product_id" value="%d" />', (int) $row['product_id'] );
			printf( '<input type="hidden" name="back" value="%s" />', esc_attr( $back ) );
			echo self::type_select( 'product_type', isset( $row['product_type'] ) ? (string) $row['product_type'] : '', __( '— choose —', 'wellness-chatbot' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			printf( ' <button type="submit" class="button">%s</button>', esc_html__( 'Confirm', 'wellness-chatbot' ) );
			echo '</form></td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	private static function render_test() {
		echo '<h2>' . esc_html__( 'Test a question', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Type what a customer would type. You will see how the assistant understood it and exactly which products it would show, and why. Nothing is shown to any customer. Costs one small chat-model call.', 'wellness-chatbot' ) . '</p>';
		echo '<div id="wwc-test-question">';
		printf( '<p><input type="text" id="wwc-test-input" class="large-text" placeholder="%s" /></p>', esc_attr__( 'e.g. Suggest me a shampoo for dry scalp', 'wellness-chatbot' ) );
		printf( '<p><button type="button" class="button button-primary" id="wwc-test-run">%s</button></p>', esc_html__( 'Test', 'wellness-chatbot' ) );
		echo '<div id="wwc-test-result" aria-live="polite"></div>';
		echo '</div>';
	}

	// --- Handlers ---------------------------------------------------------------

	public static function handle_save_categories() {
		WWC_Admin::verify_post( 'wwc_save_categories' );

		$mappings = array();
		if ( isset( $_POST['mappings'] ) && is_array( $_POST['mappings'] ) ) {
			foreach ( wp_unslash( $_POST['mappings'] ) as $id => $row ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
				$shelf = isset( $row['shelf'] ) ? sanitize_key( $row['shelf'] ) : '';
				if ( '' === $shelf || ! array_key_exists( $shelf, self::shelves() ) ) {
					continue;
				}
				$type       = isset( $row['type'] ) ? sanitize_key( $row['type'] ) : '';
				$mappings[] = array(
					'woo_category_id'    => (int) $id,
					'shelf'              => $shelf,
					'fixed_product_type' => '' === $type ? null : $type,
				);
			}
		}

		$response = WWC_Backend_Client::post( '/api/admin/categories', array( 'mappings' => $mappings ) );
		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'categories_saved' ) );
	}

	public static function handle_suggest_categories() {
		WWC_Admin::verify_post( 'wwc_suggest_categories' );
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 180 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_set_time_limit
		}
		$response = WWC_Backend_Client::post(
			'/api/admin/categories/suggest',
			array( 'only_unconfirmed' => ! empty( $_POST['only_unconfirmed'] ) ),
			array( 'timeout' => 170 )
		);
		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'categories_suggested' ) );
	}

	public static function handle_set_product_type() {
		WWC_Admin::verify_post( 'wwc_set_product_type' );

		$product_id = isset( $_POST['product_id'] ) ? absint( $_POST['product_id'] ) : 0;
		$type       = isset( $_POST['product_type'] ) ? sanitize_key( wp_unslash( $_POST['product_type'] ) ) : '';
		$back       = isset( $_POST['back'] ) ? esc_url_raw( wp_unslash( $_POST['back'] ) ) : '';

		$ok = false;
		if ( $product_id && '' !== $type ) {
			$response = WWC_Backend_Client::post( '/api/admin/products/' . $product_id . '/type', array( 'product_type' => $type ) );
			$ok       = ! is_wp_error( $response );
			if ( $ok ) {
				// Mirrored onto the product, like every other _wwc_* field.
				update_post_meta( $product_id, '_wwc_product_type', $type );
			}
		}

		$target = '' !== $back ? $back : admin_url( 'admin.php?page=' . self::PAGE );
		wp_safe_redirect( add_query_arg( 'wwc_notice', $ok ? 'type_saved' : 'failed', $target ) . '#wwc-products' );
		exit;
	}

	private static function ajax_guard() {
		check_ajax_referer( 'wwc_admin', 'nonce' );
		if ( ! WWC_Roles::can_manage() ) {
			wp_send_json_error( array( 'message' => __( 'You do not have permission to do that.', 'wellness-chatbot' ) ), 403 );
		}
	}

	/**
	 * One batch of the resync. The browser calls this page by page, so no
	 * single request runs long enough to hit a hosting time limit.
	 */
	public static function ajax_resync_chunk() {
		self::ajax_guard();

		$page  = isset( $_POST['page'] ) ? max( 1, absint( $_POST['page'] ) ) : 1;
		$batch = wc_get_products(
			array(
				'status'           => 'publish',
				'limit'            => self::RESYNC_SIZE,
				'page'             => $page,
				'orderby'          => 'ID',
				'order'            => 'ASC',
				'return'           => 'objects',
				'suppress_filters' => true,
			)
		);

		$products = array();
		foreach ( $batch as $product ) {
			if ( $product instanceof WC_Product && WWC_Wpml::is_canonical( $product->get_id() ) ) {
				$products[] = WWC_Product_Payload::build( $product );
			}
		}

		if ( ! empty( $products ) ) {
			$response = WWC_Backend_Client::post( '/api/admin/catalogue/import', array( 'products' => $products ), array( 'timeout' => 60 ) );
			if ( is_wp_error( $response ) ) {
				wp_send_json_error( array( 'message' => $response->get_error_message() ), 502 );
			}
		}

		wp_send_json_success(
			array(
				'page' => $page,
				'sent' => count( $products ),
				'done' => count( $batch ) < self::RESYNC_SIZE,
			)
		);
	}

	public static function ajax_test_question() {
		self::ajax_guard();

		$question = isset( $_POST['question'] ) ? sanitize_text_field( wp_unslash( $_POST['question'] ) ) : '';
		if ( '' === $question ) {
			wp_send_json_error( array( 'message' => __( 'Type a question first.', 'wellness-chatbot' ) ), 400 );
		}

		$response = WWC_Backend_Client::post( '/api/admin/accuracy/test', array( 'question' => $question ), array( 'timeout' => 60 ) );
		if ( is_wp_error( $response ) ) {
			wp_send_json_error( array( 'message' => $response->get_error_message() ), 502 );
		}
		wp_send_json_success( $response );
	}
}
